import { type ReactElement, useState } from "react";
import type { InitialData } from "./types.ts";
import type { SessionView } from "./types.ts";
import { splitTabKey } from "./tabs.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useUpdateStatus } from "./hooks/useUpdateStatus.ts";
import { useSessionActions } from "./hooks/useSessionActions.ts";
import { quit } from "./shell.ts";
import { useTabs } from "./hooks/useTabs.ts";
import { TabBar } from "./components/TabBar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import { RecentSessionsModal } from "./components/RecentSessionsModal.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";

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
    reopenSession,
  } = useTabs(setViews);
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

  return (
    <div className="app">
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
          // Key by tab so switching sessions never leaks draft text or
          // scroll position between sessions.
          <ChatView
            key={activeTab ?? undefined}
            view={activeView}
            peerId={activeTab ? splitTabKey(activeTab).peerId : ""}
            onPrompt={(text, images) =>
              activeTab && prompt(activeTab, text, images)}
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
            peers={peers}
            onStart={startSession}
            onWorkspaceChanged={handleWorkspaceChanged}
            onDeleteWorkspace={deleteWorkspace}
            onReopenSession={reopenSession}
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
