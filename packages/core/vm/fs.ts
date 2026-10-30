/**
 * The stella VM's implementation of {@link FileBackend}: every operation is
 * one `podman exec` inside the machine.
 *
 * The VM's home (`/home/agent`) is the backend's root: relative paths
 * resolve against the session's working folder below it, and every path the
 * machine answers for must land inside the home. Nothing is mounted from the
 * host, which is what makes "the agent works inside its own machine" true
 * rather than a convention. The root is the whole machine home rather than
 * one agent's folder — like Terasuma, an agent may read and write the other
 * agents' folders when the user asks it to, and the working folder is a
 * default, not a wall.
 *
 * The cost of one container call per operation is why the two searches
 * matter most. `find` does the walking inside the machine (one call, with
 * the same pruning rules the host walk applies), while the MATCHING runs
 * here against the returned paths — the same `globToRegExp` and
 * `GitignoreMatcher` the host uses. Sharing the matcher rather than
 * re-implementing glob and gitignore semantics in shell is what keeps the two
 * backends answering the same question the same way; only the walk crosses
 * the boundary.
 */
import { posix, relative } from "node:path";
import { base64ToBytes, textToBase64 } from "../base64.ts";
import { firstLine, mergeRanges, stripTrailingCR } from "../lines.ts";
import type { ResolvedPath } from "../workspace/sandbox.ts";
import {
  type BackendDirEntry,
  type BackendGrepResult,
  type BackendStat,
  type FileBackend,
  type GlobRequest,
  type GrepRequest,
  type LineRange,
  previewLine,
  type RangeReadResult,
} from "../tools/file-backend.ts";
import { BUILD_ARTIFACT_DIRS } from "../workspace/walk.ts";
import { GitignoreMatcher, globToRegExp } from "../tools/gitignore.ts";
import { VM_WORKDIR } from "./contract.ts";
import type { VmExec } from "./container.ts";

/** Bound for one file operation (a local call; this only guards against a
 * wedged machine). */
const FILE_TIMEOUT_MS = 60_000;
/** Bound for one search call. */
const SEARCH_TIMEOUT_MS = 120_000;
/** Largest file a single read transfers (bytes). */
const MAX_READ_BYTES = 32 * 1024 * 1024;
/** Character budget for a search call's output. The tool truncates further;
 * this only bounds what crosses the boundary. */
const SEARCH_OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Files larger than this are skipped by grep (the host's cap). */
const GREP_MAX_FILE_SIZE = 8 * 1024 * 1024;
/** How many files one grep call inspects at a time inside the machine. */
const GREP_BATCH = 200;

/** Quote a value for a POSIX shell: single quotes, with embedded ones
 * closed and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell script that greps a set of roots inside the machine.
 *
 * `grep -r` emits `path:line: text`, the shape the model reads on the host
 * too. `--exclude-dir` prunes the artifact directories; `-I` skips binary
 * files; hidden files ARE searched (grep has no hidden flag, matching the
 * host tool). An unreadable file is skipped by grep itself, so a search never
 * fails on one.
 */
export function grepCommand(
  roots: readonly string[],
  request: GrepRequest,
): string {
  const excludes = [...BUILD_ARTIFACT_DIRS]
    .map((dir) => `--exclude-dir=${shellQuote(dir)}`)
    .join(" ");
  const flags = [
    "-r",
    "-n",
    "-I",
    request.caseSensitive ? "" : "-i",
    excludes,
    `--regexp=${shellQuote(request.pattern)}`,
    "--",
  ].filter((part) => part !== "").join(" ");
  const targets = roots.map(shellQuote).join(" ");
  // `|| true`: grep exits 1 when nothing matched, which is not a failure, and
  // `head` closing the pipe early would otherwise look like one.
  return `grep ${flags} ${targets} 2>/dev/null | head -n ${request.maxResults} || true`;
}

/**
 * The shell script that lists every file under the roots with the walk
 * policy both backends share: artifact directories pruned, symlinks never
 * followed, hidden entries skipped only when asked. Matching happens on this
 * side (see the module comment).
 */
export function walkCommand(
  roots: readonly string[],
  hidden: boolean,
): string {
  const prune = [...BUILD_ARTIFACT_DIRS]
    .map((dir) => `-name ${shellQuote(dir)}`)
    .join(" -o ");
  const hiddenTest = hidden ? "" : " ! -name '.*'";
  return roots
    .map((root) =>
      `find ${shellQuote(root)} -type d \\( ${prune} \\) -prune -o ` +
      `-type f${hiddenTest} ! -type l -print 2>/dev/null || true`
    )
    .join("\n");
}

/**
 * The VM file backend.
 *
 * All paths the agent sees are absolute inside the machine, or relative to
 * the session's working folder. `resolve` accepts the shapes the host sandbox
 * does — an absolute path inside the machine's home, or a path relative to
 * the working folder — and tolerates `~` the way a shell would, because the
 * machine's home is where a shell would land too.
 */
export class VmFileBackend implements FileBackend {
  readonly roots: readonly string[] = [VM_WORKDIR];
  readonly #exec: VmExec;
  /** The folder relative paths resolve against (the session's working folder;
   * the machine's home when a caller has none). */
  readonly #cwd: string;
  /** `.gitignore` matchers per walk root, read through the exec seam and
   * cached for this backend's lifetime (a search runs on every turn). */
  readonly #gitignore = new Map<string, GitignoreMatcher | null>();

  constructor(exec: VmExec, options: { cwd?: string } = {}) {
    this.#exec = exec;
    this.#cwd = options.cwd ?? VM_WORKDIR;
  }

  resolve(requested: string): Promise<ResolvedPath> {
    return Promise.resolve(resolveVmPath(requested, this.#cwd));
  }

  async stat(path: string): Promise<BackendStat | undefined> {
    // One call answers both questions: nothing for an absent path, else the
    // kind and the size. `stat -c` avoids parsing `ls` output.
    const result = await this.#exec(
      [
        "sh",
        "-c",
        'if [ -e "$1" ]; then stat -c "%F|%s" -- "$1"; fi',
        "sh",
        path,
      ],
      { timeoutMs: FILE_TIMEOUT_MS, maxOutput: 4096 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not inspect ${path}: ${firstLine(result.stderr)}`);
    }
    const text = result.stdout.trim();
    if (text === "") return undefined;
    const [kind, size] = text.split("|");
    return {
      isFile: kind === "regular file" || kind === "regular empty file",
      size: Number(size ?? 0),
    };
  }

  async readText(path: string): Promise<string> {
    const { bytes } = await this.readHead(path, MAX_READ_BYTES);
    return new TextDecoder().decode(bytes);
  }

  async readHead(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }> {
    // base64: a read hands binary files (images) to the model as image
    // blocks, so the payload must not pass through a text decode.
    const result = await this.#exec(
      ["base64", "--wrap=0", "--", path],
      {
        timeoutMs: FILE_TIMEOUT_MS,
        maxOutput: Math.ceil(maxBytes / 3) * 4 + 8,
        keep: "head",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not read ${path}: ${firstLine(result.stderr)}`);
    }
    if (result.truncated) {
      throw new Error(
        `${path} is larger than ${Math.floor(maxBytes / 1024)}KB; read it ` +
          "with a line range instead",
      );
    }
    const bytes = base64ToBytes(result.stdout.trim());
    return { bytes, size: bytes.byteLength };
  }

  async readRanges(
    path: string,
    ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    // One `sed` per merged range, in a single shell call: a ranged read of a
    // huge log must not transfer the file.
    const merged = mergeRanges(ranges);
    const maxTo = merged[merged.length - 1]!.to;
    const script = [
      `wc -l < ${shellQuote(path)} 2>/dev/null || echo 0`,
      ...merged.map((range) =>
        `sed -n ${shellQuote(`${range.from},${range.to}p`)} ${
          shellQuote(path)
        } 2>/dev/null`
      ),
    ].join("\n");
    const result = await this.#exec(["sh", "-c", script], {
      timeoutMs: FILE_TIMEOUT_MS,
      maxOutput: SEARCH_OUTPUT_LIMIT,
      keep: "head",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not read ${path}: ${firstLine(result.stderr)}`);
    }
    // The first line is the file's line count; the rest are the requested
    // ranges in order.
    const newline = result.stdout.indexOf("\n");
    const reported = newline === -1
      ? Number(result.stdout.trim())
      : Number(result.stdout.slice(0, newline).trim());
    const body = newline === -1 ? "" : result.stdout.slice(newline + 1);
    const lines = body.length === 0
      ? []
      : body.replace(/\n$/, "").split("\n").map(stripTrailingCR);
    return {
      lines,
      endOfFile: Number.isFinite(reported) && reported < maxTo,
      lastLine: Number.isFinite(reported) ? reported : 0,
      // The container runner bounds what crosses the boundary with
      // `keep: "head"`, so a cut here loses the END of the ranges (the host
      // backend, which can hold everything, drops the front instead). Saying
      // which side was lost keeps the note honest.
      droppedLines: 0,
      truncatedTail: result.truncated,
    };
  }

  async writeText(
    path: string,
    text: string,
    options: { private?: boolean } = {},
  ): Promise<void> {
    // The payload travels over stdin (base64), never as part of a shell
    // string: quoting a whole source file correctly is not worth attempting.
    const result = await this.#exec(
      [
        "sh",
        "-c",
        `mkdir -p -- "$(dirname -- "$1")" && ${
          options.private === true ? "umask 077 && " : ""
        }base64 --decode > "$1"`,
        "sh",
        path,
      ],
      {
        timeoutMs: FILE_TIMEOUT_MS,
        stdin: new TextEncoder().encode(textToBase64(text)),
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not write ${path}: ${firstLine(result.stderr)}`);
    }
  }

  async removeFile(path: string): Promise<void> {
    // Pruning is best effort, as on the host backend: `rm -f` is silent when
    // the file is already gone.
    await this.#exec(["rm", "-f", "--", path], {
      timeoutMs: FILE_TIMEOUT_MS,
      maxOutput: 4096,
    });
  }

  async listDir(path: string): Promise<BackendDirEntry[]> {
    // "d|" / "f|" / "l|" then the name (names stay last, so one containing
    // "|" survives). The globs cover dotfiles without matching "." or "..".
    const result = await this.#exec(
      [
        "sh",
        "-c",
        'cd "$1" 2>/dev/null || exit 3; ' +
        "for entry in * .[!.]* ..?*; do " +
        '[ -e "$entry" ] || [ -L "$entry" ] || continue; ' +
        'if [ -L "$entry" ]; then printf "l|%s\\n" "$entry"; ' +
        'elif [ -d "$entry" ]; then printf "d|%s\\n" "$entry"; ' +
        'else printf "f|%s\\n" "$entry"; fi; done',
        "sh",
        path,
      ],
      { timeoutMs: FILE_TIMEOUT_MS, maxOutput: SEARCH_OUTPUT_LIMIT },
    );
    if (result.exitCode === 3) {
      throw new Error(`Path does not exist: ${path}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`Could not list ${path}: ${firstLine(result.stderr)}`);
    }
    const entries: BackendDirEntry[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.length < 3) continue;
      entries.push({
        name: line.slice(2),
        isDirectory: line[0] === "d",
        isSymlink: line[0] === "l",
      });
    }
    return entries;
  }

  async mkdirp(path: string): Promise<void> {
    const result = await this.#exec(["mkdir", "-p", "--", path], {
      timeoutMs: FILE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not create ${path}: ${firstLine(result.stderr)}`,
      );
    }
  }

  async grep(request: GrepRequest): Promise<BackendGrepResult> {
    const roots = await this.searchRoots(request.path);
    if (roots.length === 0) return { lines: [], files: 0 };
    const result = await this.#exec(["sh", "-c", grepCommand(roots, request)], {
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxOutput: SEARCH_OUTPUT_LIMIT,
      keep: "head",
    });
    // Exit 1 is "no match", not a failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`Search failed: ${firstLine(result.stderr)}`);
    }
    const ignored = await this.gitignoreFor(roots, request.gitignore);
    const lines: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.length === 0) continue;
      if (lines.length >= request.maxResults) break;
      const parsed = parseGrepLine(line);
      if (parsed === undefined) continue;
      if (ignored?.(parsed.path) === true) continue;
      lines.push(
        `${parsed.path}:${parsed.line}: ${previewLine(parsed.text)}`,
      );
    }
    const files = new Set(lines.map((line) => line.slice(0, line.indexOf(":"))))
      .size;
    return { lines, files };
  }

  async glob(request: GlobRequest): Promise<string[]> {
    const roots = await this.searchRoots(request.path);
    if (roots.length === 0) return [];
    const re = globToRegExp(request.pattern.replace(/\\/g, "/"));
    const found: string[] = [];
    const ignored = await this.gitignoreFor(roots, request.gitignore);
    const walked = await this.#exec(
      ["sh", "-c", walkCommand(roots, request.hidden)],
      {
        timeoutMs: SEARCH_TIMEOUT_MS,
        maxOutput: SEARCH_OUTPUT_LIMIT,
        keep: "head",
      },
    );
    if (walked.exitCode !== 0) {
      throw new Error(`Search failed: ${firstLine(walked.stderr)}`);
    }
    const rootOf = (path: string) =>
      roots.find((root) => isInside(root, path)) ?? roots[0]!;
    for (const file of walked.stdout.split("\n")) {
      if (file.length === 0) continue;
      if (found.length >= request.maxResults) break;
      // A single named file matches against its own path; a walked file
      // against its path relative to the root it came from.
      const relativeTo = relative(rootOf(file), file).replace(/\\/g, "/");
      const subject = file === rootOf(file) ? file : relativeTo;
      if (!re.test(subject)) continue;
      if (ignored?.(file) === true) continue;
      found.push(file);
    }
    return found;
  }

  /** The roots a search visits: the resolved `path`, or the session's
   * working folder. A path that does not exist fails with the host's
   * wording. */
  private async searchRoots(requested: string | undefined): Promise<string[]> {
    if (requested === undefined) return [this.#cwd];
    const resolved = await this.resolve(requested);
    if (!resolved.ok) throw new Error(resolved.reason);
    const stat = await this.stat(resolved.path);
    if (stat === undefined) {
      throw new Error(`Path does not exist: ${requested}`);
    }
    // A directly named file is searched on its own (see grep/glob).
    return [resolved.path];
  }

  /** The `.gitignore` filter for these roots, or undefined when the request
   * did not ask for one. Read through the exec seam once per root and cached:
   * a root is the machine's home or a subdirectory of it, and the matcher
   * resolves a path to its owning root by containment. */
  private async gitignoreFor(
    roots: readonly string[],
    enabled: boolean,
  ): Promise<((path: string) => boolean) | undefined> {
    if (!enabled) return undefined;
    const root = roots[0] ?? VM_WORKDIR;
    if (!this.#gitignore.has(root)) {
      const result = await this.#exec(
        [
          "sh",
          "-c",
          'cat "$1" 2>/dev/null || true',
          "sh",
          `${root}/.gitignore`,
        ],
        { timeoutMs: FILE_TIMEOUT_MS, maxOutput: 1024 * 1024 },
      );
      const text = result.stdout;
      this.#gitignore.set(
        root,
        text.trim() === "" ? null : GitignoreMatcher.fromText(root, text),
      );
    }
    const matcher = this.#gitignore.get(root);
    if (matcher === null || matcher === undefined) return undefined;
    return (path) => {
      const owner = root;
      const rel = relative(owner, path).replace(/\\/g, "/");
      return matcher.ignores(owner, rel, false);
    };
  }
}

/** One parsed grep result line, or undefined when it does not have the
 * `path:line:` shape (kept nowhere: grep's own output is the contract). */
function parseGrepLine(
  line: string,
): { path: string; line: string; text: string } | undefined {
  const first = line.indexOf(":");
  if (first === -1) return undefined;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return undefined;
  const lineNo = line.slice(first + 1, second);
  if (!/^\d+$/.test(lineNo)) return undefined;
  return {
    path: line.slice(0, first),
    line: lineNo,
    text: line.slice(second + 1).replace(/^\s/, ""),
  };
}

/** Resolve a model-supplied path inside the machine: `~` is expanded as a
 * shell would, a relative path resolves from the working folder (`~` = the
 * machine's home), and anything landing outside the home is refused with the
 * wording the host sandbox uses. The home, not the working folder, is the
 * boundary: one agent may reach another agent's folder, and the prompt says
 * so. */
export function resolveVmPath(
  requested: string,
  cwd: string = VM_WORKDIR,
): ResolvedPath {
  if (typeof requested !== "string" || requested.length === 0) {
    return { ok: false, reason: "Path must be a non-empty string" };
  }
  const expanded = requested === "~"
    ? VM_WORKDIR
    : requested.startsWith("~/")
    ? posix.join(VM_WORKDIR, requested.slice(2))
    : requested;
  const absolute = posix.isAbsolute(expanded)
    ? posix.normalize(expanded)
    : posix.resolve(cwd, expanded);
  if (!isInside(VM_WORKDIR, absolute)) {
    return { ok: false, reason: `Path is outside the workspace: ${requested}` };
  }
  return { ok: true, path: absolute };
}

/** True when `path` is `root` itself or inside it (both absolute and
 * normalized). */
function isInside(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

export { GREP_BATCH, GREP_MAX_FILE_SIZE };
