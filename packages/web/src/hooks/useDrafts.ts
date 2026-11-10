import { useCallback, useEffect, useRef, useState } from "preact/compat";
import type { PendingFile, PendingImage } from "../types.ts";

/** Draft (unsent) composer content of a tab: text, attached images, and the
 * files that go into the machine (stella only). */
export interface TabDraft {
  input: string;
  images: PendingImage[];
  files: PendingFile[];
}

/** The draft of a tab that has not been typed in. Shared and never
 * mutated: every update in useDrafts creates a fresh draft object. */
export const EMPTY_DRAFT: TabDraft = { input: "", images: [], files: [] };

/** Per-tab composer drafts, keyed by tab key. A pane keeps its composer
 * mounted while another tab is shown (see components/SessionPane), so this is
 * no longer about surviving a remount: it is the App owning "what was typed
 * in which tab", so closing a tab discards exactly its draft and nothing
 * else.
 *
 * `openKeys` is the sessions this page has open, not the strip it draws: the
 * strip holds the draft tab only while `/code` is the screen (see useTabs),
 * and navigating to a session must not throw away what was typed on the
 * new-session screen. A key that drops out of `openKeys` was closed — its
 * draft goes with it. */
export function useDrafts(openKeys: readonly string[]) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, TabDraft>>(
    () => new Map(),
  );
  // The previous open set, to tell a closed tab apart from a key that was
  // never listed: the draft screen's own key (DRAFT_TAB) is not a session and
  // has no entry to drop out of, so its draft survives every tab switch.
  const prevKeysRef = useRef<string[]>([]);

  // Drop the drafts of tabs that were closed since the last change.
  useEffect(() => {
    const prev = prevKeysRef.current;
    prevKeysRef.current = [...openKeys];
    const closed = prev.filter((t) => !openKeys.includes(t));
    if (closed.length === 0) return;
    setDrafts((current) => {
      let changed = false;
      const next = new Map(current);
      for (const key of closed) {
        if (next.delete(key)) changed = true;
      }
      return changed ? next : current;
    });
  }, [openKeys]);

  /** Update part of a tab's draft (creates the entry on the first edit;
   * keeps the existing map when nothing changed so unrelated renders do
   * not churn it). */
  const updateDraft = useCallback((key: string, patch: Partial<TabDraft>) => {
    setDrafts((prev) => {
      const current = prev.get(key) ?? EMPTY_DRAFT;
      const next = { ...current, ...patch };
      if (
        next.input === current.input && next.images === current.images &&
        next.files === current.files
      ) {
        return prev;
      }
      const updated = new Map(prev);
      updated.set(key, next);
      return updated;
    });
  }, []);

  /** Discard a tab's draft (after a submit or a session start). */
  const clearDraft = useCallback((key: string) => {
    setDrafts((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  return { drafts, updateDraft, clearDraft };
}
