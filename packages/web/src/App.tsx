import { useCallback, useEffect, useRef, useState } from "react";
import { api, connectEvents } from "./api.ts";
import type {
  ClientEvent,
  InitialData,
  SessionView,
  Workspace,
} from "./types.ts";
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

export interface AppProps {
  /** Preloaded data rendered into the SSR HTML; undefined when not SSR. */
  initialData?: InitialData;
}

export function App({ initialData }: AppProps) {
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
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const restoredRef = useRef(false);

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
      const restoredTabs: string[] = [];
      const restoredViews = new Map<string, SessionView>();
      await Promise.all(ids.map(async (id) => {
        try {
          const [info, messages] = await Promise.all([
            api.openSession(id),
            api.getMessages(id),
          ]);
          restoredTabs.push(id);
          restoredViews.set(id, {
            info,
            messages,
            streamingText: "",
            runningTools: new Map(),
          });
        } catch {
          // The session no longer exists; skip it.
        }
      }));
      if (disposed) return;
      restoredRef.current = true;
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
      api.setSetting("theme", next).catch(console.error);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setWorkspaces(await api.listWorkspaces());
  }, []);

  useEffect(() => {
    // With SSR the data is already present; refresh only in the non-SSR path.
    if (!initialData) {
      load().catch(console.error);
    }
  }, [load, initialData]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disconnect: (() => void) | undefined;

    const connect = () => {
      disconnect = connectEvents(
        (event) => handleEvent(event, viewsRef.current, setViews),
        () => {
          // Reconnect on close after a short delay (loop until disposed).
          if (disposed) return;
          timer = setTimeout(connect, 1500);
        },
      );
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      disconnect?.();
    };
  }, []);

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

  const handleWorkspaceCreated = useCallback((ws: Workspace) => {
    setWorkspaces((prev) => [ws, ...prev]);
  }, []);

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
        next.set(session.id, {
          info: session,
          messages: [],
          streamingText: "",
          runningTools: new Map(),
        });
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
      try {
        const updated = await api.updateSessionModel(
          sessionId,
          provider,
          modelId,
        );
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
      {activeView
        ? (
          <ChatView
            view={activeView}
            onPrompt={(text) => activeTab && prompt(activeTab, text)}
            onAbort={() => activeTab && abort(activeTab)}
            onModelChange={(provider, modelId) =>
              activeTab && changeModel(activeTab, provider, modelId)}
          />
        )
        : (
          <NewSessionView
            workspaces={workspaces}
            onStart={startSession}
            onWorkspaceCreated={handleWorkspaceCreated}
          />
        )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function handleEvent(
  event: ClientEvent,
  current: Map<string, SessionView>,
  setViews: React.Dispatch<React.SetStateAction<Map<string, SessionView>>>,
) {
  const update = (sessionId: string, fn: (v: SessionView) => SessionView) => {
    const v = current.get(sessionId);
    if (!v) return;
    setViews((prev) => {
      const target = prev.get(sessionId);
      if (!target) return prev;
      const next = new Map(prev);
      next.set(sessionId, fn(target));
      return next;
    });
  };

  switch (event.type) {
    case "reload":
      // Dev mode: the server rebuilt the bundle; refresh to pick it up.
      location.reload();
      return;
    case "agent_start":
      return;
    case "message_start": {
      update(event.sessionId, (v) => {
        if (event.message.role === "assistant") {
          return { ...v, streamingText: "" };
        }
        // Replace the optimistic version of this message if present.
        const exists = v.messages.some(
          (m) =>
            m.timestamp === event.message.timestamp &&
            m.role === event.message.role,
        );
        return {
          ...v,
          messages: exists
            ? v.messages.map((m) =>
              m.timestamp === event.message.timestamp ? event.message : m
            )
            : [...v.messages, event.message],
        };
      });
      return;
    }
    case "message_delta":
      update(event.sessionId, (v) => ({
        ...v,
        streamingText: v.streamingText + event.delta,
      }));
      return;
    case "message_end": {
      update(event.sessionId, (v) => {
        if (event.message.role === "assistant") {
          return {
            ...v,
            messages: [...v.messages, event.message],
            streamingText: "",
          };
        }
        // Replace the optimistic/partial version of this message.
        const messages = v.messages.map((m) =>
          m.timestamp === event.message.timestamp ? event.message : m
        );
        return { ...v, messages, streamingText: "" };
      });
      return;
    }
    case "tool_start":
      update(event.sessionId, (v) => {
        const runningTools = new Map(v.runningTools);
        runningTools.set(event.toolCallId, event.toolName);
        return { ...v, runningTools };
      });
      return;
    case "tool_end":
      update(event.sessionId, (v) => {
        const runningTools = new Map(v.runningTools);
        runningTools.delete(event.toolCallId);
        return { ...v, runningTools };
      });
      return;
    case "agent_end":
      return;
    case "session_error":
      update(event.sessionId, (v) => ({ ...v, error: event.message }));
      return;
  }
}
