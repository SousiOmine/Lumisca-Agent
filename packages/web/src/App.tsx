import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, connectEvents, type SessionInfoDto } from "./api.ts";
import {
  type AgentMessage,
  type ClientEvent,
  emptyView,
  type InitialData,
  type SessionView,
  type ThinkingLevel,
  type Workspace,
} from "./types.ts";
import { applyEvent, mergeMessages } from "./events.ts";
import { THEME_KEY } from "@lumisca/core/shared";
import { TabBar } from "./components/TabBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import type { ComposerModel } from "./components/Composer.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";

/** Tab id for the not-yet-created "new session" draft tab. */
const DRAFT_TAB = "__new__";

/** localStorage keys for restoring the open tabs after a restart. */
const TABS_KEY = "lumisca.tabs";
const ACTIVE_TAB_KEY = "lumisca.activeTab";

/** Period between opportunistic message re-syncs (see syncMessages). */
const SYNC_INTERVAL_MS = 20_000;

export interface AppProps {
  /** Preloaded data rendered into the SSR HTML; undefined when not SSR. */
  initialData?: InitialData;
}

export function App({ initialData }: AppProps): ReactElement {
  const [theme, setTheme] = useState<"light" | "dark">(
    initialData?.theme ?? "dark",
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>(
    initialData?.workspaces ?? [],
  );
  const [views, setViews] = useState<Map<string, SessionView>>(new Map());
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const viewsRef = useRef(views);
  // Ref writes happen in an effect: writing during render breaks under
  // concurrent rendering. The WS event handler reads the ref, so it always
  // sees the latest views.
  useEffect(() => {
    viewsRef.current = views;
  }, [views]);
  const restoredRef = useRef(false);
  const modelChangeSeq = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
          const [info, messages] = await Promise.all([
            api.getSession(id),
            api.getMessages(id),
          ]);
          restoredViews.set(id, restoreView(info, messages));
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
  }, []);

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

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      api.setSetting(THEME_KEY, next).catch(console.error);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setWorkspaces(await api.listWorkspaces());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    // With SSR the data is already present; refresh only in the non-SSR path.
    if (!initialData) {
      load();
    }
  }, [load, initialData]);

  /** Re-fetch persisted messages for every open tab and merge them in
   * without duplicating what is already shown. Runs on reconnect and on an
   * interval so a run that completes while the socket was down is not lost
   * until the next WS drop. */
  const syncMessages = useCallback(async () => {
    const ids = [...viewsRef.current.keys()];
    const fetched = new Map<string, AgentMessage[]>();
    await Promise.all(ids.map(async (id) => {
      try {
        fetched.set(id, await api.getMessages(id));
      } catch {
        // Server not reachable yet; keep the current list.
      }
    }));
    if (fetched.size === 0) return;
    setViews((prev) => {
      const next = new Map(prev);
      for (const [id, messages] of fetched) {
        const v = next.get(id);
        if (!v) continue;
        const merged = mergeMessages(v.messages, messages);
        if (merged.length === v.messages.length) continue;
        next.set(id, { ...v, messages: merged });
      }
      return next;
    });
  }, []);

  /** Clear per-session transient state (stuck streaming/tool indicators)
   * and re-fetch persisted messages, so nothing is lost after a WS drop. */
  const resync = useCallback(async () => {
    setViews((prev) => {
      const next = new Map(prev);
      for (const [id, v] of next) {
        next.set(id, {
          ...v,
          streamingText: "",
          runningTools: new Map(),
          error: undefined,
        });
      }
      return next;
    });
    await syncMessages();
  }, [syncMessages]);

  /** Apply a WS event to the matching session view (pure reducer). */
  const handleEvent = useCallback((event: ClientEvent) => {
    if (event.type === "reload") {
      // Dev mode: the server rebuilt the bundle; refresh to pick it up.
      location.reload();
      return;
    }
    if (event.type === "session_created") return;
    setViews((prev) => {
      const target = prev.get(event.sessionId);
      if (!target) return prev;
      const nextView = applyEvent(event, target);
      if (nextView === null || nextView === target) return prev;
      const next = new Map(prev);
      next.set(event.sessionId, nextView);
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disconnect: (() => void) | undefined;

    const connect = () => {
      disconnect = connectEvents(
        handleEvent,
        () => {
          // On close: clear stuck state and re-sync, then reconnect.
          if (disposed) return;
          resync();
          timer = setTimeout(connect, 1500);
        },
        resync,
      );
    };
    connect();

    // Opportunistic sync: a run that finishes entirely inside a disconnect
    // window would otherwise only appear at the next WS drop.
    const syncTimer = setInterval(() => {
      syncMessages();
    }, SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(syncTimer);
      disconnect?.();
    };
  }, [handleEvent, resync, syncMessages]);

  /** Record an error on a session view (no-op when the tab is gone). */
  const setViewError = useCallback((sessionId: string, error: unknown) => {
    setViews((prev) => {
      const current = prev.get(sessionId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(sessionId, {
        ...current,
        error: error instanceof Error ? error.message : String(error),
      });
      return next;
    });
  }, []);

  /** Open (or focus) the draft "new session" tab. */
  const openDraftTab = useCallback(() => {
    setTabs((prev) => (prev.includes(DRAFT_TAB) ? prev : [...prev, DRAFT_TAB]));
    setActiveTab(DRAFT_TAB);
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    if (sessionId !== DRAFT_TAB) {
      api.closeSession(sessionId).catch(console.error);
    }
    setTabs((prev) => {
      const next = prev.filter((id) => id !== sessionId);
      return next;
    });
    setViews((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    setActiveTab((current) => {
      if (current !== sessionId) return current;
      const remaining = tabs.filter((id) => id !== sessionId);
      return remaining.at(-1) ?? null;
    });
  }, [tabs]);

  const handleWorkspaceChanged = useCallback((ws: Workspace) => {
    setWorkspaces((prev) => {
      const exists = prev.some((w) => w.id === ws.id);
      if (exists) return prev.map((w) => (w.id === ws.id ? ws : w));
      return [ws, ...prev];
    });
  }, []);

  const handleWorkspaceDeleted = useCallback((id: string) => {
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
  }, []);

  /** The single delete flow (confirm + API + state), shared by the draft
   * tab and the workspace edit modal. */
  const deleteWorkspace = useCallback(async (ws: Workspace) => {
    if (!globalThis.confirm(`ワークスペース「${ws.name}」を削除しますか？`)) {
      return;
    }
    await api.deleteWorkspace(ws.id);
    handleWorkspaceDeleted(ws.id);
  }, [handleWorkspaceDeleted]);

  /** Create a session from the draft tab and send the first prompt. */
  const startSession = useCallback(
    async (workspaceId: string, model: ComposerModel | null, text: string) => {
      const session = await api.createSession({
        workspaceId,
        ...(model
          ? { modelProvider: model.provider, modelId: model.modelId }
          : {}),
      });
      setTabs((prev) => {
        if (prev.includes(DRAFT_TAB)) {
          return prev.map((t) => (t === DRAFT_TAB ? session.id : t));
        }
        return [...prev, session.id];
      });
      setActiveTab(session.id);
      setViews((prev) => {
        const next = new Map(prev);
        next.set(session.id, emptyView(session));
        return next;
      });
      try {
        await api.prompt(session.id, text.trim());
      } catch (error) {
        setViewError(session.id, error);
      }
    },
    [setViewError],
  );

  const prompt = useCallback(async (sessionId: string, text: string) => {
    const textTrimmed = text.trim();
    if (!textTrimmed) return;
    // The user message appears via the WebSocket event stream
    // (message_start), so no optimistic append is needed.
    try {
      await api.prompt(sessionId, textTrimmed);
    } catch (error) {
      setViewError(sessionId, error);
    }
  }, [setViewError]);

  const abort = useCallback((sessionId: string) => {
    api.abort(sessionId).catch(console.error);
  }, []);

  const changeModel = useCallback(
    async (sessionId: string, provider: string, modelId: string) => {
      const seq = ++modelChangeSeq.current;
      try {
        const updated = await api.updateSessionModel(
          sessionId,
          provider,
          modelId,
        );
        // A newer switch may have resolved first; never show a stale model.
        if (modelChangeSeq.current !== seq) return;
        setViews((prev) => {
          const current = prev.get(sessionId);
          if (!current) return prev;
          const next = new Map(prev);
          next.set(sessionId, { ...current, info: updated });
          return next;
        });
      } catch (error) {
        console.error(error);
      }
    },
    [],
  );

  /** The thinking level is a per-model setting: update the views of every
   * open session using that model so the control stays in sync. */
  const changeThinkingLevel = useCallback(
    async (
      provider: string,
      modelId: string,
      level: ThinkingLevel,
    ) => {
      try {
        const { thinkingLevel } = await api.setModelThinkingLevel(
          provider,
          modelId,
          level,
        );
        setViews((prev) => {
          const next = new Map(prev);
          for (const [id, v] of next) {
            if (
              v.info.modelProvider !== provider || v.info.modelId !== modelId
            ) {
              continue;
            }
            if (v.info.thinkingLevel === thinkingLevel) continue;
            next.set(id, {
              ...v,
              info: { ...v.info, thinkingLevel },
            });
          }
          return next;
        });
      } catch (error) {
        console.error(error);
      }
    },
    [],
  );

  const viewFor = (sessionId: string): SessionView | undefined =>
    views.get(sessionId);
  const activeView = activeTab ? viewFor(activeTab) : undefined;

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        views={views}
        activeTab={activeTab}
        theme={theme}
        onSelect={setActiveTab}
        onClose={closeTab}
        onNew={openDraftTab}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setShowSettings(true)}
      />
      {loadError && (
        <div className="msg">
          <div className="msg-body error-text">
            <p>サーバーに接続できません: {loadError}</p>
          </div>
        </div>
      )}
      {activeView
        ? (
          // Key by tab so switching sessions never leaks draft text or
          // scroll position between sessions.
          <ChatView
            key={activeTab ?? undefined}
            view={activeView}
            onPrompt={(text) => activeTab && prompt(activeTab, text)}
            onAbort={() => activeTab && abort(activeTab)}
            onModelChange={(provider, modelId) =>
              activeTab && changeModel(activeTab, provider, modelId)}
            onThinkingLevelChange={(level) =>
              changeThinkingLevel(
                activeView.info.modelProvider,
                activeView.info.modelId,
                level,
              )}
          />
        )
        : (
          <NewSessionView
            workspaces={workspaces}
            onStart={startSession}
            onWorkspaceChanged={handleWorkspaceChanged}
            onDeleteWorkspace={deleteWorkspace}
          />
        )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/** View state for a restored tab: show the last run error (if any) so a
 * failure that happened without a connected UI is not silently hidden. */
function restoreView(
  info: SessionInfoDto,
  messages: AgentMessage[],
): SessionView {
  const v = emptyView(info, messages);
  if (info.lastError) v.error = info.lastError;
  return v;
}
