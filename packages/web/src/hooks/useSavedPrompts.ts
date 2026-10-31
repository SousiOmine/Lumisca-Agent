import { useCallback, useEffect, useSyncExternalStore } from "preact/compat";
import { errorMessage as errorText } from "@lumisca/core/shared";
import { api } from "../api.ts";
import type { SavedPrompt } from "../types.ts";
import { createStore } from "../store.ts";

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

interface SavedPromptsState {
  prompts: SavedPrompt[];
  /** Last read failure, or null. The previously known list is kept: an empty
   * menu would be worse than a stale one, but the caller can say so. */
  error: string | null;
  /** True once a read settled (success or failure). */
  loaded: boolean;
}

const store = createStore<SavedPromptsState>({
  prompts: [],
  error: null,
  loaded: false,
});

/** One read in flight, shared by every caller (the answer is the same). */
let reading: Promise<void> | null = null;

function reloadSavedPrompts(): Promise<void> {
  if (reading !== null) return reading;
  reading = (async () => {
    try {
      const result = await api.getSavedPrompts();
      store.set({ prompts: result.prompts, error: null, loaded: true });
    } catch (failure) {
      // Keep the last known list, but do not hide the failure: the user
      // would otherwise wonder why a prompt added elsewhere is missing.
      store.set({ ...store.get(), error: errorText(failure), loaded: true });
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Replace the list and read it back from the server, so every screen sees
 * the stored order and the server's validation, not the caller's guess. */
export async function saveSavedPrompts(
  write: () => Promise<unknown>,
): Promise<void> {
  await write();
  await reloadSavedPrompts();
}

/** Drop the store's contents (tests: a fixture must not inherit the previous
 * test's prompts). */
export function resetSavedPromptsStore(): void {
  reading = null;
  store.set({ prompts: [], error: null, loaded: false });
}

/** The saved prompts for a component; reads once, then stays in step with
 * every write through {@link saveSavedPrompts}. */
export function useSavedPrompts(): {
  prompts: SavedPrompt[];
  error: string | null;
  reload: () => void;
} {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [],
  );
  const state = useSyncExternalStore(subscribe, () => store.get());
  // The first subscriber reads; later ones reuse the result (the panels can
  // open in any order, and none of them should re-fetch what another screen
  // already loaded). Deferred to an effect: a read that settled synchronously
  // would publish during this render.
  useEffect(() => {
    if (!store.get().loaded) void reloadSavedPrompts();
  }, []);
  return {
    prompts: state.prompts,
    error: state.error,
    reload: () => void reloadSavedPrompts(),
  };
}
