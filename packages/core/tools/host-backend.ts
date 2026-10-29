import { relative } from "node:path";
import { BUILD_ARTIFACT_DIRS, walkEntries } from "../workspace/walk.ts";
import type { ResolvedPath, Sandbox } from "../workspace/sandbox.ts";
import {
  type GitignoreMatcher,
  globToRegExp,
  loadCachedGitignore,
} from "./gitignore.ts";
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
} from "./file-backend.ts";
import { MAX_TOOL_OUTPUT } from "./truncate.ts";

/** Files larger than this are skipped by grep on every backend (a model
 * grepping a huge file costs more than the search is worth). */
export const MAX_GREP_FILE_SIZE = 8 * 1024 * 1024;

/** Files are read in batches of this many, overlapping I/O without
 * unbounded memory use. */
const GREP_CONCURRENCY = 16;

/** Walk every file under `root` with the tools' shared policy (sorted,
 * depth-first, symlinks never followed, build-artifact directories always
 * pruned). */
async function* walkFiles(
  root: string,
  options: {
    skipHidden: boolean;
    gitignore: GitignoreMatcher | undefined;
  },
): AsyncGenerator<string> {
  const gitignore = options.gitignore;
  for await (
    const entry of walkEntries(root, {
      skipHidden: options.skipHidden,
      gitignore,
      excludedDirs: BUILD_ARTIFACT_DIRS,
    })
  ) {
    if (!entry.isDir) yield entry.path;
  }
}

/** True when `text` is not searchable text: a NUL byte survives the UTF-8
 * decode, which is the same cheap binary test the file tools have always
 * used. */
function isBinary(text: string): boolean {
  return text.includes("\u0000");
}

/** Grep one file; returns its matching lines. An empty array means the file
 * was skipped: unreadable, not a regular file, over the size cap, binary or
 * vanished. Skipping is the point — a search walks a tree that can change
 * under it, so a missing file is not an error (unlike the tools that read
 * one file the caller named). */
async function grepFileLines(
  path: string,
  re: RegExp,
  maxFileSize: number,
  maxResults: number,
): Promise<string[]> {
  const stat = await Deno.stat(path).catch(() => null);
  if (stat === null || !stat.isFile || stat.size > maxFileSize) return [];
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return [];
  }
  if (isBinary(text)) return [];
  const hits: string[] = [];
  const split = text.split("\n");
  for (let i = 0; i < split.length && hits.length < maxResults; i++) {
    if (re.test(split[i]!)) {
      hits.push(`${path}:${i + 1}: ${previewLine(split[i]!)}`);
    }
  }
  return hits;
}

/** Append `hits` to `out`, never exceeding `maxResults`. */
function appendLines(out: string[], hits: string[], maxResults: number) {
  for (const line of hits) {
    if (out.length >= maxResults) break;
    out.push(line);
  }
}

/**
 * The host (this machine) implementation of {@link FileBackend}: a workspace
 * sandbox for path resolution plus the Deno filesystem for everything else.
 *
 * The search walks live here now — grep and glob both read through
 * {@link FileBackend} — so the walk policy, the `.gitignore` filtering and
 * the skip rules have one definition on the host side, the same one the
 * workspace file listing uses (workspace/walk.ts).
 */
export class HostFileBackend implements FileBackend {
  readonly roots: readonly string[];
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.#sandbox = sandbox;
    this.roots = sandbox.roots;
  }

  /** The workspace roots' `.gitignore` matcher, cached until one of the
   * files changes. Loaded from every root (not just the one being searched):
   * the matcher finds the owning root by containment, so a search inside a
   * subdirectory still applies the root's anchored patterns. */
  private gitignore(): Promise<GitignoreMatcher> {
    return loadCachedGitignore(this.#sandbox);
  }

  resolve(requested: string): Promise<ResolvedPath> {
    return this.#sandbox.resolve(requested);
  }

  async stat(path: string): Promise<BackendStat | undefined> {
    const stat = await Deno.stat(path).catch(() => null);
    if (stat === null) return undefined;
    return { isFile: stat.isFile, size: stat.size };
  }

  readText(path: string): Promise<string> {
    return Deno.readTextFile(path);
  }

  async readHead(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }> {
    const stat = await Deno.stat(path);
    const file = await Deno.open(path, { read: true });
    try {
      const buffer = new Uint8Array(Math.min(maxBytes, stat.size));
      let read = 0;
      while (read < buffer.length) {
        const n = await file.read(buffer.subarray(read));
        if (n === null) break;
        read += n;
      }
      return { bytes: buffer.subarray(0, read), size: stat.size };
    } finally {
      file.close();
    }
  }

  async writeText(path: string, text: string): Promise<void> {
    await Deno.mkdir(parentOf(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }

  async readRanges(
    path: string,
    ranges: readonly LineRange[],
  ): Promise<RangeReadResult> {
    const merged = mergeRanges(ranges);
    const maxTo = merged[merged.length - 1]!.to;
    const lines: string[] = [];
    let startIndex = 0;
    let collectedBytes = 0;
    let lastLine = 0;
    let index = 0;
    let pastMax = false;
    for await (const [no, text] of readLines(path)) {
      lastLine = no;
      while (index < merged.length && no > merged[index]!.to) index++;
      const current = merged[index];
      if (current === undefined) {
        pastMax = true;
        break;
      }
      if (no >= current.from) {
        lines.push(text);
        collectedBytes += text.length + 1;
        // Only the last MAX_TOOL_OUTPUT bytes can ever be displayed; drop
        // the front as the collection exceeds that (keeping at least one
        // line) so huge ranges stay memory-bounded.
        while (
          collectedBytes > MAX_TOOL_OUTPUT && startIndex < lines.length - 1
        ) {
          collectedBytes -= lines[startIndex]!.length + 1;
          startIndex++;
        }
      }
    }
    return {
      lines: lines.slice(startIndex),
      endOfFile: !pastMax && lastLine < maxTo,
      lastLine,
    };
  }

  async listDir(path: string): Promise<BackendDirEntry[]> {
    const entries: BackendDirEntry[] = [];
    for await (const entry of Deno.readDir(path)) {
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
      });
    }
    return entries;
  }

  async grep(request: GrepRequest): Promise<BackendGrepResult> {
    const re = new RegExp(request.pattern, request.caseSensitive ? "" : "i");
    const gitignore = request.gitignore ? await this.gitignore() : undefined;
    const lines: string[] = [];
    let files = 0;
    for (const root of await this.searchRoots(request.path)) {
      if (root.isFile) {
        // Explicitly targeted files bypass the walk (and its gitignore
        // filtering): the caller named exactly this file.
        const hits = await grepFileLines(
          root.path,
          re,
          request.maxFileSize,
          request.maxResults,
        );
        if (hits.length > 0) files++;
        appendLines(lines, hits, request.maxResults);
      } else {
        files += await grepTree(root.path, re, request, gitignore, lines);
      }
      if (lines.length >= request.maxResults) break;
    }
    return { lines, files };
  }

  async glob(request: GlobRequest): Promise<string[]> {
    const re = globToRegExp(request.pattern.replace(/\\/g, "/"));
    const gitignore = request.gitignore ? await this.gitignore() : undefined;
    const found: string[] = [];
    for (const root of await this.searchRoots(request.path)) {
      if (root.isFile) {
        // A directly named file matches against its own path: a pattern is
        // root-relative for a directory search and path-relative here.
        if (re.test(root.path.replace(/\\/g, "/"))) found.push(root.path);
      } else {
        for await (
          const file of walkFiles(root.path, {
            skipHidden: !request.hidden,
            gitignore,
          })
        ) {
          const rel = relative(root.path, file).replace(/\\/g, "/");
          if (!re.test(rel)) continue;
          found.push(file);
          if (found.length >= request.maxResults) break;
        }
      }
      if (found.length >= request.maxResults) break;
    }
    return found;
  }

  /** The roots a search visits: the explicitly requested path (resolved
   * inside the sandbox, and only that one), or every root that still
   * exists. A root that vanished is skipped rather than refused — a search
   * must not fail because a folder was unregistered or moved away under
   * it. */
  private async searchRoots(
    requested: string | undefined,
  ): Promise<SearchRoot[]> {
    if (requested !== undefined) {
      const resolved = await this.resolve(requested);
      if (!resolved.ok) throw new Error(resolved.reason);
      const stat = await Deno.stat(resolved.path).catch(() => null);
      if (stat === null) throw new Error(`Path does not exist: ${requested}`);
      return [{ path: resolved.path, isFile: stat.isFile }];
    }
    const roots: SearchRoot[] = [];
    for (const root of this.roots) {
      const stat = await Deno.stat(root).catch(() => null);
      if (stat === null) continue;
      roots.push({ path: root, isFile: stat.isFile });
    }
    return roots;
  }
}

/** One root of a search call. */
interface SearchRoot {
  path: string;
  isFile: boolean;
}

/** Sort ranges by start and merge overlaps/adjacency, so membership checks
 * run against a small sorted list without materializing every line number. */
function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/** Strip a trailing `\r` so CRLF lines read back as clean LF lines (edits
 * match line endings leniently, so the raw bytes are not needed here). */
function stripTrailingCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Stream a file's lines as [1-based line number, text]. The trailing `\n`
 * and a trailing `\r` (CRLF files) are stripped, so the model always sees
 * LF-style lines. Stops early when the consumer breaks. */
async function* readLines(path: string): AsyncGenerator<[number, string]> {
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(64 * 1024);
  let lineNo = 1;
  let carry = "";
  try {
    while (true) {
      const n = await file.read(buffer);
      if (n === null) break;
      carry += decoder.decode(buffer.subarray(0, n), { stream: true });
      // A single line can exceed the output budget by far (minified
      // files); keep only its tail so a line-ranged read never buffers
      // the whole file in memory.
      if (carry.length > MAX_TOOL_OUTPUT) carry = carry.slice(-MAX_TOOL_OUTPUT);
      let start = 0;
      for (let i = 0; i < carry.length; i++) {
        if (carry[i] === "\n") {
          yield [lineNo++, stripTrailingCR(carry.slice(start, i))];
          start = i + 1;
        }
      }
      carry = carry.slice(start);
    }
    const tail = carry + decoder.decode();
    if (tail.length > 0) yield [lineNo, stripTrailingCR(tail)];
  } finally {
    file.close();
  }
}

/** Grep every file under a directory in concurrent batches, appending
 * matches in walk order so the output stays deterministic. */
async function grepTree(
  root: string,
  re: RegExp,
  request: GrepRequest,
  gitignore: GitignoreMatcher | undefined,
  out: string[],
): Promise<number> {
  let files = 0;
  let batch: string[] = [];
  const flush = async () => {
    const results = await Promise.all(
      batch.map((file) =>
        grepFileLines(file, re, request.maxFileSize, request.maxResults)
      ),
    );
    for (const hits of results) {
      if (!hits.length) continue;
      files++;
      appendLines(out, hits, request.maxResults);
    }
    batch = [];
  };
  for await (
    const file of walkFiles(root, {
      skipHidden: false,
      gitignore,
    })
  ) {
    batch.push(file);
    if (batch.length >= GREP_CONCURRENCY) {
      await flush();
      if (out.length >= request.maxResults) return files;
    }
  }
  if (batch.length > 0 && out.length < request.maxResults) await flush();
  return files;
}

/** Parent directory of an absolute path, without a `node:path` round trip
 * for the common case of a path that has a separator. */
function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
