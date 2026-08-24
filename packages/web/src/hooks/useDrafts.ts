import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingImage } from "../types.ts";

/** Draft (unsent) composer content of a tab: text + attached images. */
export interface TabDraft {
  input: string;
  images: PendingImage[];
}

/** The draft of a tab that has not been typed in. Shared and never
 * mutated: every update in useDrafts creates a fresh draft object. */
export const EMPTY_DRAFT: TabDraft = { input: "", images: [] };

/** Per-tab composer drafts, kept across tab switches. The chat view
 * remounts on every switch (it is keyed by the active tab), so anything
 * it held locally would be lost — the drafts live here instead, keyed by
 * tab key, and are fed back into the view when the tab is shown again.
 * A tab that is closed discards its draft; a tab that never existed
 * (the draft screen shown while no tab is open keeps its input under the
 * draft-tab key) does not: only keys that dropped OUT of the tab list
 * since the last change are pruned, so drafts survive "open a session,
 * come back" as long as their tab was not closed. */
export function useDrafts(tabs: readonly string[]) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, TabDraft>>(
    () => new Map(),
  );
  // The previous tab list, to tell closed tabs apart from tabs that are
  // simply not open yet (e.g. the draft screen before the draft tab is
  // opened: its draft is keyed by DRAFT_TAB, which never was in the list).
  const prevTabsRef = useRef<string[]>([]);

  // Drop the drafts of tabs that were closed since the last change.
  useEffect(() => {
    const prev = prevTabsRef.current;
    prevTabsRef.current = [...tabs];
    const closed = prev.filter((t) => !tabs.includes(t));
    if (closed.length === 0) return;
    setDrafts((current) => {
      let changed = false;
      const next = new Map(current);
      for (const key of closed) {
        if (next.delete(key)) changed = true;
      }
      return changed ? next : current;
    });
  }, [tabs]);

  /** Update part of a tab's draft (creates the entry on the first edit;
   * keeps the existing map when nothing changed so unrelated renders do
   * not churn it). */
  const updateDraft = useCallback((key: string, patch: Partial<TabDraft>) => {
    setDrafts((prev) => {
      const current = prev.get(key) ?? EMPTY_DRAFT;
      const next = { ...current, ...patch };
      if (next.input === current.input && next.images === current.images) {
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
