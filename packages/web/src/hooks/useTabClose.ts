import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { useT } from "../i18n.ts";
import { isViewRunning, type SessionView } from "../types.ts";

/** A close waiting for the user's answer. */
export interface PendingClose {
  /** The tabs the close targets. */
  ids: string[];
  /** The running ones among them: what the dialog warns about and what
   * "keep running" exempts from `POST /close`. */
  running: Set<string>;
  /** Display names of the running tabs, in tab order (the dialog lists
   * them; a session title is free text, so no sentence carries them). */
  names: string[];
}

export interface CloseRequest {
  /** The close waiting for an answer, or null. */
  pending: PendingClose | null;
  /** Close the tabs, asking first when one of them is running. */
  request(ids: string[]): void;
  /** Answer the dialog: stop the running sessions and close, or close the
   * tabs and let them finish on the server. */
  resolve(keepRunning: boolean): void;
  /** Dismiss the dialog without closing anything. */
  cancel(): void;
}

/**
 * Closing tabs, and the question a running one raises.
 *
 * Closing a tab sends `POST /sessions/:id/close`, which aborts the run, kills
 * the session's background commands and tears down its sub-agents. A user who
 * only wanted the tab gone loses a long investigation that way, so the dialog
 * offers both: stop everything, or close the tab and leave the run going on
 * the server (reopened from the session history).
 *
 * Extracted from App.tsx: this is a tab-lifecycle rule, not a page-layout
 * one, and it was the only state in App that a component could not reach.
 */
export function useTabClose(options: {
  views: ReadonlyMap<string, SessionView>;
  /** Close tabs; `keepRunning` lists the sessions to leave running. */
  closeTabs(ids: string[], keepRunning?: Set<string>): void;
}): CloseRequest {
  const { views, closeTabs } = options;
  const t = useT();
  const [pending, setPending] = useState<PendingClose | null>(null);

  // The live view map, read by the callbacks below. The map is replaced on
  // every streamed event, so taking it as a dependency would rebuild every
  // close callback per event and hand the memoized TabBar a new function each
  // time — its memo would then never hold. A ref, written in an effect and
  // not during render: writing during render breaks under concurrent
  // rendering (the same reason useSessionEvents keeps one).
  const viewsRef = useRef(views);
  useEffect(() => {
    viewsRef.current = views;
  }, [views]);

  const request = useCallback(
    (ids: string[]) => {
      const live = viewsRef.current;
      const running = ids.filter((id) => {
        const view = live.get(id);
        return view !== undefined && isViewRunning(view);
      });
      if (running.length === 0) {
        closeTabs(ids);
        return;
      }
      setPending({
        ids,
        running: new Set(running),
        names: running.map(
          (id) => live.get(id)?.info.name || t("chrome.tabBar.newSession"),
        ),
      });
    },
    [closeTabs, t],
  );

  const resolve = (keepRunning: boolean) => {
    if (pending === null) return;
    const { ids, running } = pending;
    setPending(null);
    closeTabs(ids, keepRunning ? running : undefined);
  };

  return {
    pending,
    request,
    resolve,
    cancel: () => setPending(null),
  };
}
