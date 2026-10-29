import type { ResolvedPath } from "../workspace/sandbox.ts";

/**
 * The file surface every sandboxed file/search tool works against.
 *
 * A tool describes WHAT it needs (resolve a path, read a file, grep a tree)
 * and never WHY the files live where they do: the host implementation
 * (HostFileBackend, tools/host-backend.ts) reads this machine's disk, and
 * the stella implementation (vm/fs.ts) runs the same operations inside the
 * session's virtual machine over `podman exec`. One interface is what lets
 * read / write / edit / list_dir / grep / glob keep a single definition —
 * one wording for their truncation notes, one path-resolution contract, one
 * set of tests for the tool logic.
 *
 * The contract each method must honour, so the host and the VM look like the
 * same machine to the model:
 *
 * - `resolve` normalizes and confines a requested path to `roots`. It never
 *   throws for an invalid path: the reason travels in the result so callers
 *   pick their own wording.
 * - `stat` answers `undefined` for a path that does not exist. A search root
 *   that vanished is skipped, never an error; anything else is a real
 *   failure and throws.
 * - `readText` / `readHead` read whole files and do not truncate — the tools
 *   do, so the note the model reads is identical everywhere.
 * - `writeText` creates missing parent directories.
 * - `grep` / `glob` own their whole search (walk included), so each backend
 *   can use the cheapest mechanism it has: the host walks in memory, the VM
 *   runs the container's own grep/find. Both must return results in a
 *   deterministic order and honour the skip rules described on the request
 *   types.
 */
export interface FileBackend {
  /** Absolute roots a model-supplied path may resolve inside, sorted (see
   * Sandbox.roots for why the order matters). A backend with one root (the
   * VM's home) exposes exactly one. */
  readonly roots: readonly string[];

  /** Resolve and confine a path. */
  resolve(requested: string): Promise<ResolvedPath>;

  /** The entry's facts, or undefined when it does not exist. */
  stat(path: string): Promise<BackendStat | undefined>;

  /** The whole file as UTF-8 text. Throws when it is missing or unreadable. */
  readText(path: string): Promise<string>;

  /** The first `maxBytes` of the file plus its full size, so the caller can
   * tell a complete read from a cut one. `bytes` may end mid-character;
   * callers decode leniently. */
  readHead(
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; size: number }>;

  /** Create or overwrite a file, creating missing parent directories. */
  writeText(path: string, text: string): Promise<void>;

  /** Read selected 1-based, inclusive line ranges of a file. Implementations
   * must not load the whole file for a narrow range (the host streams, the
   * VM asks the container's `sed`), so a ranged read of a huge log stays
   * cheap. `lines` are returned with the trailing `\n` and a trailing `\r`
   * stripped, in request order. */
  readRanges(
    path: string,
    ranges: readonly LineRange[],
  ): Promise<RangeReadResult>;

  /** The directory's entries, unsorted (callers sort). */
  listDir(path: string): Promise<BackendDirEntry[]>;

  /** Search file contents for a regular expression. */
  grep(request: GrepRequest): Promise<BackendGrepResult>;

  /** Find files by glob pattern. */
  glob(request: GlobRequest): Promise<string[]>;
}

/** What `stat` reports: only the facts the tools act on. */
export interface BackendStat {
  isFile: boolean;
  size: number;
}

/** One line range: 1-based, inclusive. */
export interface LineRange {
  from: number;
  to: number;
}

/** The result of a ranged read. */
export interface RangeReadResult {
  /** The requested lines, in range order. */
  lines: string[];
  /** True when the file ended before the last requested line existed. */
  endOfFile: boolean;
  /** The highest line number that exists in the file (0 for an empty one).
   * Reported so the caller's "end of file" note names the real length. */
  lastLine: number;
}

export interface BackendDirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Skip rules every search honours, whatever its mechanism.
 *
 * - Build-artifact/VCS directory names (walk.ts BUILD_ARTIFACT_DIRS) are
 *   pruned at any depth.
 * - Symlinks are never followed.
 * - `hidden` false → `.`-prefixed entries are skipped.
 * - `gitignore` true → each search root's own `.gitignore` prunes matches.
 *
 * The two searches differ on hidden files: grep always searches them (only
 * `glob` exposes a `hidden` flag), which the request carries explicitly. */
interface SearchRequest {
  /** Resolved absolute path (file or directory). Undefined = every root. */
  path?: string;
  /** Apply each root's `.gitignore`. */
  gitignore: boolean;
  /** Include `.`-prefixed entries. */
  hidden: boolean;
  /** Stop after this many results. */
  maxResults: number;
}

/** One grep call, already validated by the tool (pattern length, compiled
 * regex). */
export interface GrepRequest extends SearchRequest {
  /** Regular expression source, evaluated per line. */
  pattern: string;
  /** False → case-insensitive. */
  caseSensitive: boolean;
  /** Cap for a single file; larger files are skipped rather than read. */
  maxFileSize: number;
}

/** One glob call. `pattern` is the model's own glob text (`**`, `*`, `?`,
 * `{a,b}`). */
export interface GlobRequest extends SearchRequest {
  /** Glob pattern, matched against each file's path relative to the search
   * root (posix separators). */
  pattern: string;
}

export interface BackendGrepResult {
  /** `path:line: text`, in search order. */
  lines: string[];
  /** Files with at least one match. */
  files: number;
}

/** Cap for one line of grep output. */
export const MAX_GREP_LINE_PREVIEW = 200;

/** Trim one matched line for display (`path:line: <this>`). */
export function previewLine(line: string, max = MAX_GREP_LINE_PREVIEW): string {
  const trimmed = line.replace(/\s+$/g, "");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
