import { useCallback, useEffect, useState } from "preact/compat";
import { errorMessage as errorText } from "@lumisca/core/shared";
import { api } from "../api.ts";
import type { SavedPrompt } from "../types.ts";
import { useAsyncEffect } from "./useAsync.ts";

/** Custom event name dispatched after saved prompts are mutated (create /
 * update / delete) so every slash-menu instance can re-fetch without a
 * page reload. The chat input and the new-session draft each fetch once
 * on mount; without this the menu stays stale after the settings panel
 * adds a prompt. */
export const SAVED_PROMPTS_UPDATED_EVENT = "lumisca:saved-prompts-updated";

export function notifySavedPromptsUpdated(): void {
  globalThis.dispatchEvent(new CustomEvent(SAVED_PROMPTS_UPDATED_EVENT));
}

/** Shared saved-prompts loader: fetches once on mount and re-fetches
 * whenever the global updated event fires. Every consumer sees the same
 * list without prop drilling. */
export function useSavedPrompts(): {
  prompts: SavedPrompt[];
  /** Fetch failure, if the last load did not succeed. The previously known
   * list is kept (an empty menu would be worse), but the caller can say
   * the list may be stale. */
  error: string | null;
  reload: () => void;
} {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);

  const reload = useCallback(() => setSeq((s) => s + 1), []);

  useAsyncEffect(async (isStale) => {
    try {
      const result = await api.getSavedPrompts();
      if (isStale()) return;
      setPrompts(result.prompts);
      setError(null);
    } catch (failure) {
      // Keep the last known list, but do not hide the failure: the user
      // would otherwise wonder why a prompt added elsewhere is missing.
      if (!isStale()) setError(errorText(failure));
    }
  }, [seq]);

  useEffect(() => {
    const handler = () => reload();
    globalThis.addEventListener(SAVED_PROMPTS_UPDATED_EVENT, handler);
    return () => {
      globalThis.removeEventListener(SAVED_PROMPTS_UPDATED_EVENT, handler);
    };
  }, [reload]);

  return { prompts, error, reload };
}
