import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_TOOL_OUTPUT = 64 * 1024;
export const DEFAULT_READ_LIMIT = 512 * 1024;

/** Directory holding the complete output of truncated streams (see
 * {@link OutputSpiller}): by default under the OS temp dir, so nothing is
 * written into the user's workspace. Only a run that actually truncates
 * creates it. */
export function defaultSpillDir(): string {
  return join(tmpdir(), "lumisca-tool-output");
}

/** Standard note appended when tool output was cut, e.g. `output` →
 * "[output truncated to the last 65536 bytes]". Shared by every tool. */
export function truncatedNote(kind: string, max = MAX_TOOL_OUTPUT): string {
  return `\n[${kind} truncated to the last ${max} bytes]`;
}

/** Note for a cut stream whose complete text was saved to `path`: the
 * standard wording above, plus where the full output is and how to read it
 * back. `recovery` is the how-to clause — only the caller knows what can
 * reach the file (the `read`/`grep` tools resolve paths through the
 * workspace sandbox, bash does not). */
export function spilledNote(
  kind: string,
  path: string,
  recovery: string,
  max = MAX_TOOL_OUTPUT,
): string {
  return `\n[${kind} truncated to the last ${max} bytes; full output: ${path} — ${recovery}]`;
}

/**
 * Writes the complete output of a truncated stream to a file the model can
 * read back (DSH's spill): a cut result keeps its tail inline and points at
 * this file instead of forcing the model to re-run the command to see the
 * part that was dropped.
 *
 * Best effort by design: every failure (unwritable directory, full disk,
 * name collision) is reported as `undefined`, never as an exception, so a
 * failed spill cannot break the tool result that carries it.
 */
export class OutputSpiller {
  /** Sequence of this spiller, paired with a process-wide random tag so two
   * spillers (a second session, a sub-agent, another Lumisca process) that
   * share the directory never pick the same name. */
  private seq = 0;
  private readonly tag = crypto.randomUUID().slice(0, 8);

  constructor(private readonly dir: string = defaultSpillDir()) {}

  /** Save `text` as `<dir>/<tag>-<n>-<kind>.txt` and return its path, or
   * `undefined` when nothing could be written. */
  async save(kind: string, text: string): Promise<string | undefined> {
    const path = join(this.dir, `${this.tag}-${++this.seq}-${kind}.txt`);
    try {
      // Lazy: a run that never truncates never creates the directory.
      await Deno.mkdir(this.dir, { recursive: true });
      // Owner-only (the output can hold secrets such as tokens), and never
      // overwrite: an existing file means a name collision, which falls back
      // to the note without a path rather than clobbering another spill.
      await Deno.writeTextFile(path, text, { mode: 0o600, createNew: true });
      return path;
    } catch {
      return undefined;
    }
  }
}

export function truncate(text: string, max = MAX_TOOL_OUTPUT): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(-max), truncated: true };
}
