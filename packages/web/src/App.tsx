import { type ReactElement, useState } from "react";
import type { InitialData } from "./types.ts";
import type { SessionView } from "./types.ts";
import { splitTabKey } from "./tabs.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useUpdateStatus } from "./hooks/useUpdateStatus.ts";
import { useSessionActions } from "./hooks/useSessionActions.ts";
import { usePane } from "./hooks/usePane.ts";
import { quit } from "./shell.ts";
import { DRAFT_TAB, useTabs } from "./hooks/useTabs.ts";
import { EMPTY_DRAFT, useDrafts } from "./hooks/useDrafts.ts";
import { TabBar } from "./components/TabBar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import { RecentSessionsModal } from "./components/RecentSessionsModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { PaneHeader } from "./components/PaneHeader.tsx";

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
    loaded: workspacesLoaded,
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
    reopenSession,
  } = useTabs(setViews);
  // Unsent composer content per tab: the chat view remounts on every tab
  // switch (keyed below), so the draft lives here and is fed back into
  // the view when its tab is shown again. Closing a tab discards it.
  const { drafts, updateDraft, clearDraft } = useDrafts(tabs);
  const [showSettings, setShowSettings] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  // Auto-update state (desktop only); polled here and shared with the
  // settings panel and the update banner below.
  const update = useUpdateStatus(true);
  const {
    startSession,
    prompt,
    abort,
    answer,
    rewind,
    changeModel,
    changeThinkingLevel,
  } = useSessionActions({
    setTabs,
    setActiveTab,
    setViews,
    setViewError,
    activeTab,
  });

  const activeView: SessionView | undefined = activeTab
    ? views.get(activeTab)
    : undefined;
  // The draft tab (and the equivalent draft screen shown while no tab is
  // open) keeps its unsent input under the draft-tab key.
  const draftKey = activeTab ?? DRAFT_TAB;
  const draft = drafts.get(draftKey) ?? EMPTY_DRAFT;
  // The docked pane (the agent's browser WebView today, hosted at the
  // right edge). Polled from the shell bridge: the agent's own tools
  // open/close it, and the user can hide it (the surface keeps running).
  const pane = usePane();

  return (
    <div className={pane.visible ? "app pane-open" : "app"}>
      {
        /* The desktop window is undecorated; the title bar strip holds the
       * tab bar, the app menu and the window controls (in a plain browser
       * the tab bar renders on its own). */
      }
      <TitleBar
        onNew={openDraftTab}
        onOpenRecent={() => setShowRecent(true)}
        onOpenSettings={() => setShowSettings(true)}
        onQuit={quit}
        paneOpen={pane.open}
        paneVisible={pane.visible}
        paneKind={pane.content?.kind ?? null}
        onTogglePane={pane.toggle}
      >
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
          onOpenRecent={() => setShowRecent(true)}
          onOpenSettings={() => setShowSettings(true)}
          isDesktop={update.status !== null}
          onQuit={quit}
        />
      </TitleBar>
      {
        /* Everything below the title bar: shrinks by the pane width while
       * the pane is visible (the pane is a native window that overlays
       * the app window's right edge). */
      }
      <div className="app-body">
        <UpdateBanner update={update} />
        {loadError && (
          <div className="msg">
            <div className="msg-body error-text">
              <p>サーバーに接続できません: {loadError}</p>
            </div>
          </div>
        )}
        {activeView
          ? (
            // Key by tab so switching sessions remounts the view without
            // leaking scroll position (or draft text: the draft is owned
            // by the App under the tab key and fed back in below).
            <ChatView
              key={activeTab ?? undefined}
              view={activeView}
              peerId={activeTab ? splitTabKey(activeTab).peerId : ""}
              input={draft.input}
              onInputChange={(input) => updateDraft(draftKey, { input })}
              images={draft.images}
              onImagesChange={(images) => updateDraft(draftKey, { images })}
              onPrompt={(text, images, mode) =>
                activeTab && prompt(activeTab, text, images, mode)}
              onAbort={() => activeTab && abort(activeTab)}
              onRewind={(timestamp) =>
                activeTab ? rewind(activeTab, timestamp) : Promise.resolve()}
              onAnswer={(toolCallId, answers) =>
                activeTab
                  ? answer(activeTab, toolCallId, answers)
                  : Promise.reject()}
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
              workspacesLoaded={workspacesLoaded}
              peers={peers}
              input={draft.input}
              onInputChange={(input) => updateDraft(draftKey, { input })}
              images={draft.images}
              onImagesChange={(images) => updateDraft(draftKey, { images })}
              onStart={async (fws, model, text, images) => {
                await startSession(fws, model, text, images);
                // The draft tab is replaced by the new session's tab; its
                // draft was sent, so discard it (kept on failure so the
                // user can retry).
                clearDraft(DRAFT_TAB);
              }}
              onWorkspaceChanged={handleWorkspaceChanged}
              onDeleteWorkspace={deleteWorkspace}
              onReopenSession={reopenSession}
              onOpenSettings={() => setShowSettings(true)}
            />
          )}
      </div>
      {
        /* The pane's header strip, rendered by this webview directly
       * above the native pane window (which starts below it, so they
       * never overlap). */
      }
      {pane.visible && pane.content !== null && (
        <PaneHeader
          content={pane.content}
          onHide={() => pane.setVisible(false)}
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
      {showRecent && (
        <RecentSessionsModal
          openKeys={new Set(tabs)}
          onOpen={(key) => void reopenSession(key)}
          onClose={() => setShowRecent(false)}
        />
      )}
    </div>
  );
}
