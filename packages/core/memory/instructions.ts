import type {
  ContextProvider,
  ContextUpdate,
} from "../agent/context-providers.ts";
import {
  instructionHeading,
  loadProjectMemoryFiles,
  MAX_MEMORY_BYTES,
  type MemoryFile,
} from "./agents-md.ts";

/**
 * The workspace-instructions context provider: publishes the AGENTS.md chain
 * (and the machine-level personal instructions) as durable transcript
 * messages, so an edit reaches a session that is already open.
 *
 * Publication follows the DeepSeek Harness's instruction model:
 * - the first publication is a complete baseline that replaces every earlier
 *   one, so a session opened later works from the current files;
 * - afterwards only changes are published, as `Updated instructions from:`,
 *   `Instructions from:` (a new file) and `Instructions removed:` blocks, so
 *   an edit costs the tokens of the changed file rather than the whole chain.
 *
 * The published state stores a content hash per file, never the content
 * itself: a long transcript must not pay for the same text twice.
 */

/** Provider name of the instructions context. */
export const INSTRUCTIONS_PROVIDER = "instructions";

export interface InstructionsOptions {
  /** Workspace folders whose AGENTS.md chain is published (empty for a
   * session without a workspace). */
  folders: string[];
  /** The machine-level personal instructions, read at each publication so
   * an edit is picked up like a project file. Undefined → none configured. */
  personal?: () => MemoryFile | undefined;
}

interface InstructionsState {
  files: Array<{ path: string; hash: string }>;
}

/** 64-bit FNV-1a of one file's content: change detection only, so a fast
 * non-cryptographic hash is the right tool (and it must be synchronous —
 * the provider is called inline before a run). */
function contentHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16);
}

/** The state carried by a published message, or undefined when the state is
 * absent/unreadable (the provider then publishes a fresh baseline). */
function stateOf(state: unknown): Map<string, string> | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const files = (state as InstructionsState).files;
  if (!Array.isArray(files)) return undefined;
  const known = new Map<string, string>();
  for (const file of files) {
    if (typeof file?.path !== "string" || typeof file.hash !== "string") {
      return undefined;
    }
    known.set(file.path, file.hash);
  }
  return known;
}

function stateFrom(known: Map<string, string>): InstructionsState {
  return {
    files: [...known].map(([path, hash]) => ({ path, hash })),
  };
}

/** One file's model-facing block. */
function fileBlock(file: MemoryFile, content = file.content): string {
  return `${instructionHeading(file.path)}\n\n${content}`;
}

/** The complete baseline published on the first publication: it supersedes
 * every earlier baseline in the history, so files that disappeared since the
 * last session are dropped without a separate notice. */
function baseline(files: MemoryFile[]): ContextUpdate {
  const body = files.length === 0
    ? "No workspace instructions are currently active."
    : "This complete workspace instruction baseline replaces all earlier " +
      "workspace instruction baselines. Use it as guidance when applicable; " +
      "more specific instructions take precedence over broader ones. It does " +
      "not override system, developer, or direct user instructions.\n\n" +
      files.map((file) => fileBlock(file)).join("\n\n");
  return {
    title: files.length === 0
      ? "Workspace instructions (none)"
      : `Workspace instructions (${files.length})`,
    body,
  };
}

/** The change block published when files were added, edited or removed. */
function delta(
  added: MemoryFile[],
  updated: MemoryFile[],
  removed: string[],
): ContextUpdate {
  const blocks: string[] = [];
  for (const file of added) {
    blocks.push(
      `Additional instructions from: ${file.path}\n\n${file.content}`,
    );
  }
  for (const file of updated) {
    blocks.push(
      `Updated instructions from: ${file.path}\n\n` +
        "This file changed after it was loaded. Use the following content " +
        "instead of the previously loaded instructions from this file.\n\n" +
        file.content,
    );
  }
  for (const path of removed) {
    blocks.push(
      `Instructions removed: ${path}\n\n` +
        "The previously loaded instructions from this file no longer apply.",
    );
  }
  const names = [...added, ...updated].map((file) => file.path)
    .concat(removed);
  const label = names.length === 1 ? names[0]! : `${names.length} files`;
  return {
    title: `Instructions updated: ${label}`,
    body: blocks.join("\n\n"),
  };
}

/** Cap one file's published content (a delta is not part of the baseline
 * budget, but a single message must stay bounded). */
function cap(content: string): string {
  return content.length <= MAX_MEMORY_BYTES
    ? content
    : `${
      content.slice(0, MAX_MEMORY_BYTES)
    }\n\n… (truncated at ${MAX_MEMORY_BYTES} bytes)`;
}

export function createInstructionsProvider(
  options: InstructionsOptions,
): ContextProvider {
  /** path → content hash of the last publication; undefined until the first
   * one (a fresh session, or a transcript with no instruction message). */
  let known: Map<string, string> | undefined;

  const currentFiles = (): MemoryFile[] => {
    const files = loadProjectMemoryFiles(options.folders);
    const personal = options.personal?.();
    if (personal !== undefined) {
      files.push({ path: personal.path, content: cap(personal.content) });
    }
    return files;
  };

  return {
    name: INSTRUCTIONS_PROVIDER,
    next(): ContextUpdate[] {
      const files = currentFiles();
      const current = new Map(
        files.map((file) => [file.path, contentHash(file.content)]),
      );
      if (known === undefined) {
        known = current;
        // Nothing to say for a session without instructions: publishing an
        // empty baseline would spend tokens on "no instructions".
        if (files.length === 0) return [];
        const update = baseline(files);
        return [{ ...update, state: stateFrom(current) }];
      }
      const added = files.filter((file) => !known!.has(file.path));
      const updated = files.filter((file) =>
        known!.has(file.path) &&
        known!.get(file.path) !== current.get(file.path)
      );
      const removed = [...known.keys()].filter((path) => !current.has(path));
      known = current;
      if (added.length === 0 && updated.length === 0 && removed.length === 0) {
        return [];
      }
      return [{ ...delta(added, updated, removed), state: stateFrom(current) }];
    },
    rebase(state: unknown): void {
      known = stateOf(state);
    },
  };
}
