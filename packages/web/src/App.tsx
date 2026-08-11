import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconDownload, IconX } from "@tabler/icons-react";
import { api, fed, modelApi, sessionApi } from "./api.ts";
import type {
  FederatedWorkspace,
  InitialData,
  PendingImage,
  SessionView,
  ThinkingLevel,
} from "./types.ts";
import { emptyView } from "./types.ts";
import type { ComposerModel } from "./components/Composer.tsx";
import { splitTabKey, tabKey } from "./tabs.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useUpdateStatus } from "./hooks/useUpdateStatus.ts";
import { DRAFT_TAB, useTabs } from "./hooks/useTabs.ts";
import { TabBar } from "./components/TabBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";

export interface AppProps {
  /** Preloaded data from the bootstrap script; undefined when not served. */
  initialData?: InitialData;
}

export function App({ initialData }: AppProps): ReactElement {
  const { theme, setTheme } = useTheme(initialData?.theme ?? "dark");
  const {
    workspaces,
    peers,
    loadError,
    handleWorkspaceChanged,
    deleteWorkspace,
  } = useWorkspaces(initialData);
  const { views, setViews, setViewError } = useSessionEvents();
  const {
    tabs,
    setTabs,
    activeTab,
    setActiveTab,
    openDraftTab,
    closeTab,
    closeTabsToRight,
    closeTabsToLeft,
    closeOtherTabs,
  } = useTabs(setViews);
  const [showSettings, setShowSettings] = useState(false);
  // Serial number for model switches: a stale response is discarded.
  const modelChangeSeq = useRef(0);
  // Auto-update state (desktop only); polled here and shared with the
  // settings panel and the update banner below.
  const update = useUpdateStatus(true);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  // Re-show the banner when a new update finishes downloading (the ready
  // flag toggles false -> true), but not on every poll while it stays
  // ready.
  const updateReadyRef = useRef(false);
  useEffect(() => {
    const ready = update.status?.ready ?? false;
    if (ready && !updateReadyRef.current) {
      setUpdateBannerDismissed(false);
    }
    updateReadyRef.current = ready;
  }, [update.status?.ready]);

  /** Create a session from the draft tab and send the first prompt. The
   * session runs on the peer that owns the workspace (remote workspaces
   * use the peer's default model). */
  const startSession = useCallback(
    async (
      fws: FederatedWorkspace,
      model: ComposerModel | null,
      text: string,
      images: PendingImage[],
    ) => {
      const { peerId, workspace } = fws;
      const session = peerId === ""
        ? await api.createSession({
          workspaceId: workspace.id,
          ...(model
            ? { modelProvider: model.provider, modelId: model.modelId }
            : {}),
        })
        : await fed.createSession(peerId, { workspaceId: workspace.id });
      const key = tabKey(peerId, session.id);
      setTabs((prev) => {
        if (prev.includes(DRAFT_TAB)) {
          return prev.map((t) => (t === DRAFT_TAB ? key : t));
        }
        return [...prev, key];
      });
      setActiveTab(key);
      setViews((prev) => {
        const next = new Map(prev);
        next.set(key, emptyView(session));
        return next;
      });
      try {
        await sessionApi(key).prompt(text.trim(), images);
      } catch (error) {
        setViewError(key, error);
      }
    },
    [setTabs, setActiveTab, setViews, setViewError],
  );

  const prompt = useCallback(
    async (key: string, text: string, images: PendingImage[]) => {
      const textTrimmed = text.trim();
      if (!textTrimmed && images.length === 0) return;
      // The user message appears via the WebSocket event stream
      // (message_start), so no optimistic append is needed.
      try {
        await sessionApi(key).prompt(textTrimmed, images);
      } catch (error) {
        setViewError(key, error);
      }
    },
    [setViewError],
  );

  const abort = useCallback((key: string) => {
    sessionApi(key).abort().catch(console.error);
  }, []);

  const changeModel = useCallback(
    async (key: string, provider: string, modelId: string) => {
      const seq = ++modelChangeSeq.current;
      try {
        const updated = await sessionApi(key).updateModel(provider, modelId);
        // A newer switch may have resolved first; never show a stale model.
        if (modelChangeSeq.current !== seq) return;
        setViews((prev) => {
          const current = prev.get(key);
          if (!current) return prev;
          const next = new Map(prev);
          next.set(key, { ...current, info: updated });
          return next;
        });
      } catch (error) {
        console.error(error);
      }
    },
    [setViews],
  );

  /** The thinking level is a per-model setting on the owning server:
   * update the views of every open session on the same peer that uses
   * that model so the control stays in sync. */
  const changeThinkingLevel = useCallback(
    async (
      provider: string,
      modelId: string,
      level: ThinkingLevel,
    ) => {
      const { peerId } = activeTab ? splitTabKey(activeTab) : { peerId: "" };
      try {
        const { thinkingLevel } = await modelApi(peerId).setThinkingLevel(
          provider,
          modelId,
          level,
        );
        setViews((prev) => {
          const next = new Map(prev);
          for (const [id, v] of next) {
            if (splitTabKey(id).peerId !== peerId) continue;
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
    [activeTab, setViews],
  );

  const activeView: SessionView | undefined = activeTab
    ? views.get(activeTab)
    : undefined;

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        views={views}
        activeTab={activeTab}
        onSelect={setActiveTab}
        onClose={closeTab}
        onCloseToRight={closeTabsToRight}
        onCloseToLeft={closeTabsToLeft}
        onCloseOthers={closeOtherTabs}
        onNew={openDraftTab}
        onOpenSettings={() => setShowSettings(true)}
      />
      {update.status?.ready && !updateBannerDismissed && (
        <div className="update-banner">
          <IconDownload size={16} />
          <span className="update-banner-text">
            Lumisca v{update.status.latestVersion}{" "}
            のアップデートが準備できました。インストールするとアプリが再起動します。
          </span>
          <button
            type="button"
            className="btn push"
            onClick={update.install}
          >
            インストール
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setUpdateBannerDismissed(true)}
            title="閉じる"
            aria-label="閉じる"
          >
            <IconX size={14} />
          </button>
        </div>
      )}
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
            peerId={activeTab ? splitTabKey(activeTab).peerId : ""}
            onPrompt={(text, images) =>
              activeTab && prompt(activeTab, text, images)}
            onAbort={() => activeTab && abort(activeTab)}
            onModelChange={(provider, modelId) =>
              activeTab && changeModel(activeTab, provider, modelId)}
            onThinkingLevelChange={(level) =>
              changeThinkingLevel(
                activeView.info.modelProvider,
                activeView.info.modelId,
                level,
              )}
            onOpenSettings={() => setShowSettings(true)}
          />
        )
        : (
          <NewSessionView
            workspaces={workspaces}
            peers={peers}
            onStart={startSession}
            onWorkspaceChanged={handleWorkspaceChanged}
            onDeleteWorkspace={deleteWorkspace}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
      {showSettings && (
        <SettingsModal
          theme={theme}
          onThemeChange={setTheme}
          update={update}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
