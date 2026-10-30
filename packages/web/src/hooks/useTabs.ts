import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "preact/compat";
import {
  sessionApi,
  type SessionInfoDto,
  type SessionSnapshot,
} from "../api.ts";
import { applyRunState } from "../events.ts";
import { DRAFT_TAB, withDraftTab } from "../tabs.ts";
import { emptyView, type SessionView, type TodoPhase } from "../types.ts";

/** localStorage keys for restoring the open tabs after a restart. */
const TABS_KEY = "lumisca.tabs";
const ACTIVE_TAB_KEY = "lumisca.activeTab";

/** View state for a restored tab: every piece of live state comes from the
 * snapshot (the same instant as its transcript), so a failure or a question
 * that happened without a connected UI is not silently hidden, a title
 * generated meanwhile is shown, and a run that is still going does not
 * render as finished — its `agent_start` is never replayed (see
 * applyRunState). */
function restoreView(
  info: SessionInfoDto,
  snapshot: SessionSnapshot,
  todos: TodoPhase[] = [],
): SessionView {
  const v = emptyView(info, snapshot);
  v.error = snapshot.error;
  v.todos = todos;
  v.pendingQuestions = snapshot.questions;
  if (v.info.name !== snapshot.name) {
    v.info = { ...v.info, name: snapshot.name };
  }
  return applyRunState(v, snapshot.running);
}

/** Open tabs + active tab: restore after a restart, persist on change,
 * and the close operations (single, to-right, to-left, others). The strip
 * never goes empty: with no session tab left it holds the draft tab. The
 * views map is owned by useSessionEvents; the tab logic only adds/removes
 * entries. */
export function useTabs(
  setViews: Dispatch<SetStateAction<Map<string, SessionView>>>,
  /** Seed the revision marker of a tab from the snapshot it was built from
   * (see useSessionEvents.seedRevision): a restored tab must watch for lost
   * frames from the snapshot it started with, not from its next full sync. */
  seedRevision: (key: string, rev: number) => void,
  /** Fetch and merge one tab's panel snapshots (see
   * useSessionEvents.resyncPanels). A tab reopened on a session whose run is
   * still going needs them: a run left going by "close and keep running" can
   * have sub-agent tasks and background commands that no event has described
   * to this page yet. */
  resyncPanels: (key: string) => void,
) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const restoredRef = useRef(false);

  // Restore the tabs that were open before a restart.
  useEffect(() => {
    let disposed = false;
    const restore = async () => {
      let ids: string[] = [];
      let active: string | null = null;
      try {
        ids = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]");
        active = localStorage.getItem(ACTIVE_TAB_KEY);
      } catch {
        // Unreadable storage: there is nothing to restore. The strip below
        // still gets its draft tab.
      }
      const restoredViews = new Map<string, SessionView>();
      // Restored tabs whose run is still going: their panel snapshots are
      // not in the transcript snapshot and no event has described them to
      // this page yet (see the resyncPanels call below).
      const running: string[] = [];
      await Promise.all(ids.map(async (id) => {
        try {
          // GET /sessions/:id (not /open) for the info: the messages
          // endpoint already opens the session, and the response carries
          // the last run error so a failed run is visible after a restart.
          // The todo plan is fetched alongside too — todo events are only
          // emitted on mutations, so a fresh page must restore it here —
          // and the transcript snapshot carries the run state.
          const [info, snapshot, todo] = await Promise.all([
            sessionApi(id).getSession(),
            sessionApi(id).getMessages(),
            sessionApi(id).getTodo(),
          ]);
          restoredViews.set(id, restoreView(info, snapshot, todo.todos));
          if (snapshot.running) running.push(id);
          // The tab starts watching for lost frames from this snapshot.
          seedRevision(id, snapshot.rev);
        } catch {
          // The session no longer exists; skip it.
        }
      }));
      if (disposed) return;
      restoredRef.current = true;
      // Keep the saved order: Promise.all resolves out of order, so filter
      // the original ids instead of collecting in completion order. With no
      // tab left to restore, the strip holds the draft tab rather than
      // nothing.
      const restoredTabs = withDraftTab(
        ids.filter((id) => restoredViews.has(id)),
      );
      setTabs(restoredTabs);
      setViews((prev) => new Map([...prev, ...restoredViews]));
      setActiveTab(
        active && restoredTabs.includes(active)
          ? active
          : (restoredTabs.at(-1) ?? null),
      );
      // Fill in the panels of the tabs that are still running (see
      // resyncPanels). The reconnect resync may have run before these views
      // existed — this page never saw the events of a run that kept going
      // while it was closed — so a tab restored on a live run asks here.
      for (const key of running) resyncPanels(key);
    };
    restore();
    return () => {
      disposed = true;
    };
  }, [setViews, seedRevision, resyncPanels]);

  // Persist the open tabs so they can be restored after a restart.
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify(tabs.filter((t) => t !== DRAFT_TAB)),
      );
      if (activeTab && activeTab !== DRAFT_TAB) {
        localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
      } else {
        localStorage.removeItem(ACTIVE_TAB_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, [tabs, activeTab]);

  /** Open (or focus) the draft "new session" tab. */
  const openDraftTab = useCallback(() => {
    setTabs((prev) => (prev.includes(DRAFT_TAB) ? prev : [...prev, DRAFT_TAB]));
    setActiveTab(DRAFT_TAB);
  }, []);

  /** Close the given tabs: drop the tabs and their views, and tell the
   * owning server about the sessions among them — except the ones named in
   * `keepRunning`, whose `POST /close` is skipped, so a run that is still
   * going keeps working on the server (the tab is gone, the session stays
   * open, and reopening it from the session history rejoins the run). The
   * App asks before it takes the `POST /close` route for a running tab (see
   * CloseTabsDialog). When the active tab is among the closed ones, fall
   * back to the last remaining tab (kept in the existing order); closing
   * the last tab leaves the draft tab, so the strip never empties. */
  const closeTabs = useCallback((
    ids: string[],
    keepRunning?: ReadonlySet<string>,
  ) => {
    const toClose = new Set(ids);
    for (const id of ids) {
      if (id !== DRAFT_TAB && !keepRunning?.has(id)) {
        sessionApi(id).close().catch(console.error);
      }
    }
    const nextTabs = withDraftTab(tabs.filter((id) => !toClose.has(id)));
    setTabs(nextTabs);
    setViews((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setActiveTab((current) =>
      current && nextTabs.includes(current)
        ? current
        : (nextTabs.at(-1) ?? null)
    );
  }, [tabs, setViews]);

  /** Reopen a previously closed session in a tab: load its info, transcript
   * snapshot (messages + run state) and todo plan (the same data the
   * restart restore fetches) and open the tab; an already-open session is
   * just focused. A session whose run is still going — one left running by
   * "close and keep running" — additionally asks for its panel snapshots,
   * which the transcript snapshot does not carry and no event has described
   * to this page yet. */
  const reopenSession = useCallback(async (key: string) => {
    if (tabs.includes(key)) {
      setActiveTab(key);
      return;
    }
    try {
      const [info, snapshot, todo] = await Promise.all([
        sessionApi(key).getSession(),
        sessionApi(key).getMessages(),
        sessionApi(key).getTodo(),
      ]);
      setTabs((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setViews((prev) => {
        const next = new Map(prev);
        next.set(key, restoreView(info, snapshot, todo.todos));
        return next;
      });
      seedRevision(key, snapshot.rev);
      setActiveTab(key);
      if (snapshot.running) resyncPanels(key);
    } catch (error) {
      // The session was deleted (or the owning peer is unreachable) since
      // the list was built; never crash over a stale entry.
      console.error(error);
    }
  }, [tabs, setTabs, setViews, setActiveTab, seedRevision, resyncPanels]);

  return {
    tabs,
    setTabs,
    activeTab,
    setActiveTab,
    openDraftTab,
    closeTabs,
    reopenSession,
  };
}
