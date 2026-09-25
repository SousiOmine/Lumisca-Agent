import { type ReactElement, useState } from "preact/compat";
import type { InitialData } from "./types.ts";
import type { SessionView } from "./types.ts";
import { splitTabKey } from "./tabs.ts";
import { useT } from "./i18n.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useLanguage } from "./hooks/useLanguage.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useServerHealth } from "./hooks/useServerHealth.ts";
import { useUpdateStatus } from "./hooks/useUpdateStatus.ts";
import { usePanelInset } from "./hooks/usePanelInset.ts";
import { useSessionActions } from "./hooks/useSessionActions.ts";
import { usePane } from "./hooks/usePane.ts";
import { quit } from "./shell.ts";
import { isNotifyEnabled, setNotifyEnabled } from "./notify.ts";
import { DRAFT_TAB, useTabs } from "./hooks/useTabs.ts";
import { EMPTY_DRAFT, useDrafts } from "./hooks/useDrafts.ts";
import { TabBar } from "./components/TabBar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import { RecentSessionsModal } from "./components/RecentSessionsModal.tsx";
import {
  type SettingsCategory,
  SettingsModal,
} from "./components/SettingsModal.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { ServerDownBanner } from "./components/ServerDownBanner.tsx";
import { PaneHeader } from "./components/PaneHeader.tsx";

export interface AppProps {
  /** Preloaded data from the bootstrap script; undefined when not served. */
  initialData?: InitialData;
}

export function App({ initialData }: AppProps): ReactElement {
  const t = useT();
  const { theme, setTheme, error: themeError } = useTheme(
    initialData?.theme ?? "dark",
  );
  // The language store was seeded from InitialData before the first render
  // (client.tsx); this hook owns the settings-dialog state and the persist
  // (a failed save rolls the UI back).
  const {
    language,
    setLanguage,
    error: languageError,
  } = useLanguage();
  const {
    workspaces,
    peers,
    loadError,
    loaded: workspacesLoaded,
    handleWorkspaceChanged,
    deleteWorkspace,
  } = useWorkspaces(initialData);
  // Local server health (desktop only): the WS close + API failures arm
  // it, the shell classifies (running/exited), and the banner offers
  // restart + log copy-paste. Declared before useSessionEvents so its
  // noteFailure can be wired as the connection-lost callback.
  const serverHealth = useServerHealth(true);
  const { views, setViews, setViewError } = useSessionEvents({
    onConnectionLost: () => serverHealth.noteFailure(),
  });
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
  const [settingsCategory, setSettingsCategory] = useState<
    SettingsCategory | null
  >(null);
  // Bumped when the settings dialog closes: the draft re-reads the default
  // model there, since registering (or removing) a provider changes what a
  // new session would run on. A dialog without a provider change only costs
  // one cheap request.
  const [settingsVersion, setSettingsVersion] = useState(0);
  const closeSettings = () => {
    setSettingsCategory(null);
    setSettingsVersion((version) => version + 1);
  };
  // Background agent-event notifications (desktop only): the event hook
  // reads the persisted value directly, so this state only drives the
  // settings toggle.
  const [notifyEnabled, setNotifyEnabledState] = useState(isNotifyEnabled);
  const [showRecent, setShowRecent] = useState(false);
  const handleNotifyEnabledChange = (enabled: boolean) => {
    setNotifyEnabled(enabled);
    setNotifyEnabledState(enabled);
  };
  // Auto-update state (the desktop shell's updater, or the standalone
  // server's when this page runs outside the shell); polled here and shared
  // with the settings panel and the update banner below.
  const update = useUpdateStatus(true);
  // The panels inside the chat are fixed to the top-right corner, while the
  // banners below are part of the app body's flow: the hook measures the
  // band they occupy (--app-banner-height) so the panels start below it.
  // Every banner added to the app body needs its callback here.
  const { appRef, onUpdateBannerMount, onServerBannerMount } = usePanelInset();
  const {
    startSession,
    prompt,
    abort,
    cancelGoal,
    answer,
    rewind,
    compact,
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
    <div className={pane.visible ? "app pane-open" : "app"} ref={appRef}>
      {
        /* The desktop window is undecorated; the title bar strip holds the
       * tab bar, the app menu and the window controls (in a plain browser
       * the tab bar renders on its own). */
      }
      <TitleBar
        onNew={openDraftTab}
        onOpenRecent={() => setShowRecent(true)}
        onOpenSettings={() => setSettingsCategory("general")}
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
          onOpenSettings={() => setSettingsCategory("general")}
          isDesktop={update.source === "shell"}
          onQuit={quit}
        />
      </TitleBar>
      {
        /* Everything below the title bar: shrinks by the pane width while
       * the pane is visible (the pane is a native window that overlays
       * the app window's right edge). */
      }
      <div className="app-body">
        <UpdateBanner update={update} onMount={onUpdateBannerMount} />
        <ServerDownBanner health={serverHealth} onMount={onServerBannerMount} />
        {loadError && (
          <div className="msg">
            <div className="msg-body error-text">
              <p>{t("common.serverUnreachable", { error: loadError })}</p>
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
              onCancelGoal={() => activeTab && cancelGoal(activeTab)}
              onActionCommand={(commandId, instructions) => {
                if (!activeTab) return;
                if (commandId === "compact") compact(activeTab, instructions);
              }}
              onOpenSettings={() => setSettingsCategory("providers")}
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
              onStart={async (fws, model, text, images, mode) => {
                await startSession(fws, model, text, images, mode);
                // The draft tab is replaced by the new session's tab; its
                // draft was sent, so discard it (kept on failure so the
                // user can retry).
                clearDraft(DRAFT_TAB);
              }}
              onWorkspaceChanged={handleWorkspaceChanged}
              onDeleteWorkspace={deleteWorkspace}
              onReopenSession={reopenSession}
              onOpenSettings={() => setSettingsCategory("providers")}
              settingsVersion={settingsVersion}
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
          error={pane.error}
          onHide={() => pane.setVisible(false)}
        />
      )}
      {settingsCategory !== null && (
        <SettingsModal
          theme={theme}
          themeError={themeError}
          onThemeChange={setTheme}
          language={language}
          languageError={languageError}
          onLanguageChange={setLanguage}
          update={update}
          notifyEnabled={notifyEnabled}
          onNotifyEnabledChange={handleNotifyEnabledChange}
          initialCategory={settingsCategory}
          onClose={closeSettings}
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
