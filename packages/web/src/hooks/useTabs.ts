import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { sessionApi, type SessionInfoDto } from "../api.ts";
import {
  type AgentMessage,
  emptyView,
  type SessionView,
  type TodoPhase,
} from "../types.ts";
/** Tab id for the not-yet-created "new session" draft tab. */
export const DRAFT_TAB = "__new__";

/** localStorage keys for restoring the open tabs after a restart. */
const TABS_KEY = "lumisca.tabs";
const ACTIVE_TAB_KEY = "lumisca.activeTab";

/** View state for a restored tab: show the last run error (if any) so a
 * failure that happened without a connected UI is not silently hidden. */
function restoreView(
  info: SessionInfoDto,
  messages: AgentMessage[],
  todos: TodoPhase[] = [],
): SessionView {
  const v = emptyView(info, messages);
  if (info.lastError) v.error = info.lastError;
  v.todos = todos;
  return v;
}

/** Open tabs + active tab: restore after a restart, persist on change,
 * and the close operations (single, to-right, to-left, others). The views
 * map is owned by useSessionEvents; the tab logic only adds/removes
 * entries. */
export function useTabs(
  setViews: Dispatch<SetStateAction<Map<string, SessionView>>>,
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
        return;
      }
      const restoredViews = new Map<string, SessionView>();
      await Promise.all(ids.map(async (id) => {
        try {
          // GET /sessions/:id (not /open) for the info: the messages
          // endpoint already opens the session, and the response carries
          // the last run error so a failed run is visible after a restart.
          // The todo plan is fetched alongside — todo events are only
          // emitted on mutations, so a fresh page must restore it here.
          const [info, messages, todo] = await Promise.all([
            sessionApi(id).getSession(),
            sessionApi(id).getMessages(),
            sessionApi(id).getTodo(),
          ]);
          restoredViews.set(id, restoreView(info, messages, todo.todos));
        } catch {
          // The session no longer exists; skip it.
        }
      }));
      if (disposed) return;
      restoredRef.current = true;
      // Keep the saved order: Promise.all resolves out of order, so filter
      // the original ids instead of collecting in completion order.
      const restoredTabs = ids.filter((id) => restoredViews.has(id));
      setTabs(restoredTabs);
      setViews((prev) => new Map([...prev, ...restoredViews]));
      setActiveTab(
        active && restoredTabs.includes(active)
          ? active
          : (restoredTabs.at(-1) ?? null),
      );
    };
    restore();
    return () => {
      disposed = true;
    };
  }, [setViews]);

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

  /** Close the given tabs: tell the owning server about real sessions and
   * drop the tabs and views. When the active tab is among them, fall back
   * to the last remaining tab (kept in the existing order). */
  const closeTabs = useCallback((ids: string[]) => {
    const toClose = new Set(ids);
    for (const id of ids) {
      if (id !== DRAFT_TAB) {
        sessionApi(id).close().catch(console.error);
      }
    }
    setTabs((prev) => prev.filter((id) => !toClose.has(id)));
    setViews((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setActiveTab((current) => {
      if (current && !toClose.has(current)) return current;
      return tabs.filter((id) => !toClose.has(id)).at(-1) ?? null;
    });
  }, [tabs, setViews]);

  const closeTab = useCallback((sessionId: string) => {
    closeTabs([sessionId]);
  }, [closeTabs]);

  /** Close every tab to the right of the given one. */
  const closeTabsToRight = useCallback((sessionId: string) => {
    const index = tabs.indexOf(sessionId);
    if (index === -1) return;
    closeTabs(tabs.slice(index + 1));
  }, [tabs, closeTabs]);

  /** Close every tab to the left of the given one. */
  const closeTabsToLeft = useCallback((sessionId: string) => {
    const index = tabs.indexOf(sessionId);
    if (index === -1) return;
    closeTabs(tabs.slice(0, index));
  }, [tabs, closeTabs]);

  /** Close every tab except the given one. */
  const closeOtherTabs = useCallback((sessionId: string) => {
    closeTabs(tabs.filter((id) => id !== sessionId));
  }, [tabs, closeTabs]);

  /** Reopen a previously closed session in a tab: load its info, transcript
   * and todo plan (the same data the restart restore fetches) and open the
   * tab; an already-open session is just focused. */
  const reopenSession = useCallback(async (key: string) => {
    if (tabs.includes(key)) {
      setActiveTab(key);
      return;
    }
    try {
      const [info, messages, todo] = await Promise.all([
        sessionApi(key).getSession(),
        sessionApi(key).getMessages(),
        sessionApi(key).getTodo(),
      ]);
      setTabs((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setViews((prev) => {
        const next = new Map(prev);
        next.set(key, restoreView(info, messages, todo.todos));
        return next;
      });
      setActiveTab(key);
    } catch (error) {
      // The session was deleted (or the owning peer is unreachable) since
      // the list was built; never crash over a stale entry.
      console.error(error);
    }
  }, [tabs, setTabs, setViews, setActiveTab]);

  return {
    tabs,
    setTabs,
    activeTab,
    setActiveTab,
    openDraftTab,
    closeTab,
    closeTabsToRight,
    closeTabsToLeft,
    closeOtherTabs,
    reopenSession,
  };
}
