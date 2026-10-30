import { join } from "node:path";
import type { FileBackend } from "./file-backend.ts";

export const MAX_TOOL_OUTPUT = 64 * 1024;
/** How much of a file one whole-file `read` transfers (its head; the cut
 * points at a line range for the rest). 50KB is what the model can take in
 * one look without spending the turn on a single file. */
export const DEFAULT_READ_LIMIT = 50 * 1024;

/** Standard note appended when tool output was cut, e.g. `output` →
 * "[output truncated to the last 65536 bytes]". Shared by every tool. */
export function truncatedNote(kind: string, max = MAX_TOOL_OUTPUT): string {
  return `\n[${kind} truncated to the last ${max} bytes]`;
}

/** Note for a cut stream whose complete text was saved to `path`: the
 * standard wording above, plus where the full output is and how to read it
 * back. `recovery` is the how-to clause — only the caller knows what can
 * reach the file (the `read`/`grep` tools resolve paths through the file
 * backend, bash does not). */
export function spilledNote(
  kind: string,
  path: string,
  recovery: string,
  max = MAX_TOOL_OUTPUT,
): string {
  return `\n[${kind} truncated to the last ${max} bytes; full output: ${path} — ${recovery}]`;
}

/** Writes the complete output of a truncated stream where the session's own
 * tools can read it: through `files`, so a stella session spills inside its
 * machine rather than onto the host's disk (which nothing in the machine can
 * open).
 *
 * Best effort by design: every failure (unwritable directory, full disk, a
 * name collision) is reported as `undefined`, never as an exception, so a
 * failed spill cannot break the tool result that carries it.
 *
 * The directory is scratch space, so it is bounded: at most
 * {@link MAX_SPILL_FILES} spills are kept (the oldest are removed), and a
 * session that closes its tools deletes its own spills (see `clear()`).
 * Without this, every truncated build log of a long session stayed on disk
 * forever — and, since the directory sits at the workspace root, showed up in
 * later `glob` results. */
export class OutputSpiller {
  /** Sequence of this spiller, paired with a process-wide random tag so two
   * spillers (a second session, a sub-agent, another Lumisca process) that
   * share the directory never pick the same name. */
  private seq = 0;
  private readonly tag = crypto.randomUUID().slice(0, 8);
  /** The spills this instance wrote, oldest first, with their sizes. */
  private readonly written: string[] = [];

  constructor(
    private readonly files: FileBackend,
    private readonly dir: string = defaultSpillPath(files),
  ) {}

  /** Save `text` as `<dir>/<tag>-<n>-<kind>.txt` and return its path, or
   * `undefined` when nothing could be written. */
  async save(kind: string, text: string): Promise<string | undefined> {
    const path = join(this.dir, `${this.tag}-${++this.seq}-${kind}.txt`);
    try {
      // Never overwrite: an existing file means a name collision, which falls
      // back to the note without a path rather than clobbering another spill.
      const existing = await this.files.stat(path);
      if (existing !== undefined) return undefined;
      await this.files.writeText(path, text, { private: true });
      this.written.push(path);
      await this.pruneOwn();
      return path;
    } catch {
      return undefined;
    }
  }

  /** Delete every spill this instance wrote (the session's tools are being
   * closed, and nothing can reference them any more). */
  async clear(): Promise<void> {
    const paths = this.written.splice(0);
    await Promise.all(paths.map((path) => this.files.removeFile(path)));
  }

  /** Keep only the newest MAX_SPILL_FILES of this instance's own files. A
   * spill is only useful while it is the most recent output; older ones have
   * been superseded by whatever the model read next. */
  private async pruneOwn(): Promise<void> {
    while (this.written.length > MAX_SPILL_FILES) {
      const oldest = this.written.shift();
      if (oldest !== undefined) await this.files.removeFile(oldest);
    }
  }
}

/** How many spilled outputs one tool instance keeps. Each is at most
 * MAX_TOOL_OUTPUT (64 KiB) plus the raw command output that produced it, so
 * this bounds the scratch directory to a few megabytes. */
export const MAX_SPILL_FILES = 16;

/** Where this backend's spills go: its first root, so the path is always one
 * the backend can resolve and the model can read back. The name starts with
 * a dot because it sits at the top of that root. */
function defaultSpillPath(files: FileBackend): string {
  const root = (files.roots[0] ?? ".").replace(/[\\/]+$/, "");
  return `${root}/.lumisca-tool-output`;
}

export function truncate(text: string, max = MAX_TOOL_OUTPUT): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(-max), truncated: true };
}

/** Standard note appended when output was cut from the END and the head is
 * kept — the mirror of {@link truncatedNote}, e.g. `description` →
 * "[description truncated to the first 512 bytes]". */
export function truncatedHeadNote(kind: string, max: number): string {
  return `\n[${kind} truncated to the first ${max} bytes]`;
}

/** Keep the head of `text` (the mirror of {@link truncate}, which keeps the
 * tail): for a listing, a description or a snapshot the beginning is what
 * carries the meaning, so the cut removes the end. Callers append
 * {@link truncatedHeadNote} when `truncated` is true. */
export function truncateHead(text: string, max: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
