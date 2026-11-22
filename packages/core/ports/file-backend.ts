import type { ResolvedPath } from "../workspace/sandbox.ts";

/**
 * The file surface every sandboxed file tool works against.
 *
 * A tool describes WHAT it needs (resolve a path, read a file, list a
 * directory) and never WHY the files live where they do: the host
 * implementation (HostFileBackend, tools/host/files.ts) reads this machine's
 * disk, and the stella implementation (vm/fs.ts) runs the same operations
 * inside the session's virtual machine over `podman exec`. One interface is
 * what lets read / write / edit / list_dir keep a single definition — one
 * wording for their truncation notes, one path-resolution contract, one set
 * of tests for the tool logic.
 *
 * The contract each method must honour, so the host and the VM look like the
 * same machine to the model:
 *
 * - `resolve` normalizes and confines a requested path to `roots`. It never
 *   throws for an invalid path: the reason travels in the result so callers
 *   pick their own wording.
 * - `stat` answers `undefined` for a path that does not exist; anything else
 *   is a real failure and throws.
 * - `readText` / `readHead` read whole files and do not truncate — the tools
 *   do, so the note the model reads is identical everywhere.
 * - `writeText` creates missing parent directories.
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

  /** Up to `length` bytes starting at `offset` (0-based), for moving a file
   * between machines without decoding it as text. A shorter result means the
   * file ended there; callers loop until they have what `stat` promised.
   *
   * Separate from `readHead` because the two answer different questions:
   * `readHead` is a tool's first look at a file, `readBytes` is one window of
   * a transfer, which must be able to start in the middle. */
  readBytes(path: string, offset: number, length: number): Promise<Uint8Array>;

  /** Create or overwrite a file, creating missing parent directories.
   * `private` asks for owner-only permissions where the platform has them
   * (spilled tool output can hold secrets). */
  writeText(
    path: string,
    text: string,
    options?: { private?: boolean },
  ): Promise<void>;

  /** Write raw bytes, creating missing parent directories, and overwrite the
   * file unless `append` says to add to its end. Transfers write one chunk at
   * a time, so the whole file never has to sit in memory; `append` is how the
   * second chunk knows it is not a new file. */
  writeBytes(
    path: string,
    bytes: Uint8Array,
    options?: { private?: boolean; append?: boolean },
  ): Promise<void>;

  /** Delete one file. A missing file is not an error (the caller is pruning
   * its own scratch space, and a concurrent prune may have won the race).
   * Used by {@link OutputSpiller} to bound what it keeps. */
  removeFile(path: string): Promise<void>;

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

export interface RangeReadResult {
  /** The requested lines, in range order. */
  lines: string[];
  /** True when the file ended before the last requested line existed. */
  endOfFile: boolean;
  /** The highest line number that exists in the file (0 for an empty one).
   * Reported so the caller's "end of file" note names the real length. */
  lastLine: number;
  /** Number of leading requested lines the backend had to drop to keep the
   * result inside its output bound. The backend is the only party that
   * knows this (it bounds what it transfers), so the tool reports the cut
   * from here instead of recomputing it — a silently shortened read would
   * look like a complete one to the model. */
  droppedLines: number;
  /** True when the backend cut the END of the result instead (the stella VM
   * keeps the head of what crosses the container boundary). Either flag
   * means the model did not receive every requested line. */
  truncatedTail: boolean;
}

export interface BackendDirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}
