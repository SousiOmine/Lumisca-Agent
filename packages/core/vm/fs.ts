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
 */
import { posix } from "node:path";
import { base64ToBytes, bytesToBase64, textToBase64 } from "../base64.ts";
import { firstLine, mergeRanges, stripTrailingCR } from "../lines.ts";
import type {
  BackendDirEntry,
  BackendStat,
  FileBackend,
  LineRange,
  RangeReadResult,
} from "../tools/file-backend.ts";
import type { ResolvedPath } from "../workspace/sandbox.ts";
import type { VmExec } from "./container.ts";
import { VM_WORKDIR } from "./contract.ts";
import { shellQuote } from "./quote.ts";

/** Bound for one file operation (a local call; this only guards against a
 * wedged machine). */
const FILE_TIMEOUT_MS = 60_000;
/** Largest file a single read transfers (bytes). */
const MAX_READ_BYTES = 32 * 1024 * 1024;
/** Character budget for one ranged read's output. The tool truncates
 * further; this only bounds what crosses the boundary. */
const READ_OUTPUT_LIMIT = 4 * 1024 * 1024;

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
    const result = await this.#exec(["base64", "--wrap=0", "--", path], {
      timeoutMs: FILE_TIMEOUT_MS,
      maxOutput: Math.ceil(maxBytes / 3) * 4 + 8,
      keep: "head",
    });
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

  async readBytes(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    // `tail -c +N` is 1-based, so byte 0 is `+1`. `head` stops the stream
    // once the window is complete; `base64` keeps the payload binary-safe.
    const result = await this.#exec(
      [
        "sh",
        "-c",
        'tail -c "+$2" -- "$1" | head -c "$3" | base64 --wrap=0',
        "sh",
        path,
        String(offset + 1),
        String(length),
      ],
      {
        timeoutMs: FILE_TIMEOUT_MS,
        maxOutput: Math.ceil(length / 3) * 4 + 16,
        keep: "head",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not read ${path}: ${firstLine(result.stderr)}`);
    }
    return base64ToBytes(result.stdout.trim());
  }

  async writeBytes(
    path: string,
    bytes: Uint8Array,
    options: { private?: boolean; append?: boolean } = {},
  ): Promise<void> {
    const append = options.append === true;
    const result = await this.#exec(
      [
        "sh",
        "-c",
        `mkdir -p -- "$(dirname -- "$1")" && ${
          options.private === true && !append ? "umask 077 && " : ""
        }base64 --decode ${append ? ">>" : ">"} "$1"`,
        "sh",
        path,
      ],
      {
        timeoutMs: FILE_TIMEOUT_MS,
        stdin: new TextEncoder().encode(bytesToBase64(bytes)),
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not write ${path}: ${firstLine(result.stderr)}`);
    }
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
      ...merged.map(
        (range) =>
          `sed -n ${shellQuote(`${range.from},${range.to}p`)} ${shellQuote(
            path,
          )} 2>/dev/null`,
      ),
    ].join("\n");
    const result = await this.#exec(["sh", "-c", script], {
      timeoutMs: FILE_TIMEOUT_MS,
      maxOutput: READ_OUTPUT_LIMIT,
      keep: "head",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not read ${path}: ${firstLine(result.stderr)}`);
    }
    // The first line is the file's line count; the rest are the requested
    // ranges in order.
    const newline = result.stdout.indexOf("\n");
    const reported =
      newline === -1
        ? Number(result.stdout.trim())
        : Number(result.stdout.slice(0, newline).trim());
    const body = newline === -1 ? "" : result.stdout.slice(newline + 1);
    const lines =
      body.length === 0
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
      { timeoutMs: FILE_TIMEOUT_MS, maxOutput: READ_OUTPUT_LIMIT },
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
      throw new Error(`Could not create ${path}: ${firstLine(result.stderr)}`);
    }
  }
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
  const expanded =
    requested === "~"
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
