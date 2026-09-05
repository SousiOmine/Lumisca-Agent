import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SavedPrompt } from "../types.ts";

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
  reload: () => void;
} {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);

  const reload = useCallback(() => {
    let stale = false;
    api.getSavedPrompts()
      .then((result) => {
        if (stale) return;
        setPrompts(result.prompts);
      })
      .catch(() => {
        // Non-critical: keep the last known list.
      });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = reload();
    const handler = () => {
      reload();
    };
    globalThis.addEventListener(SAVED_PROMPTS_UPDATED_EVENT, handler);
    return () => {
      cleanup?.();
      globalThis.removeEventListener(SAVED_PROMPTS_UPDATED_EVENT, handler);
    };
  }, [reload]);

  return { prompts, reload };
}
