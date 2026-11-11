import { api } from "../api.ts";
import { createResourceStore, useStore } from "../store.ts";
import type { SavedPrompt } from "../types.ts";

/**
 * The saved prompts (the settings panel's list, and the `/prompt` menu the
 * composer and the draft screen offer).
 *
 * One module-scope store: the list is read by three screens and written by
 * the settings panel, so it is exactly the "several screens read the same
 * value" case the architecture reserves for a store. It used to be a
 * `CustomEvent` on `globalThis` that told every hook instance to re-fetch —
 * two tabs' worth of prompts, three copies, and a window between the write
 * and the last read where they disagreed.
 */

interface SavedPromptsValue {
  prompts: SavedPrompt[];
}

const store = createResourceStore<SavedPromptsValue, string>({
  initial: { prompts: [] },
  load: async () => ({ prompts: (await api.getSavedPrompts()).prompts }),
  // A read that returns the stored list unchanged must not re-render the
  // screens that draw it.
  same: (a, b) => samePrompts(a.prompts, b.prompts),
});

/** Whether two prompt lists hold the same prompts, in the same order. */
function samePrompts(
  a: readonly SavedPrompt[],
  b: readonly SavedPrompt[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((prompt, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      prompt.id === other.id &&
      prompt.label === other.label &&
      prompt.prompt === other.prompt
    );
  });
}

/** The saved prompts for a component; reads once, then stays in step with
 * every write's reload. */
export function useSavedPrompts(): {
  prompts: SavedPrompt[];
  error: string | null;
  reload: () => void;
} {
  const state = useStore(store);
  return {
    prompts: state.prompts,
    error: state.error,
    reload: () => void store.reload(),
  };
}
