import {
  type ReactElement,
  useCallback,
  useMemo,
  useState,
} from "preact/compat";
import type { InitialData } from "./types.ts";
import { isViewRunning, type SessionView } from "./types.ts";
import { closeTargets, DRAFT_TAB, splitTabKey } from "./tabs.ts";
import { useT } from "./i18n.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useLanguage } from "./hooks/useLanguage.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useServerHealth } from "./hooks/useServerHealth.ts";
import { useUpdateStatus } from "./hooks/useUpdateStatus.ts";
import { usePanelInset } from "./hooks/usePanelInset.ts";
import { useSessionActions } from "./hooks/useSessionActions.ts";
import { useAppHeight } from "./hooks/useAppHeight.ts";
import { useBackspaceGuard } from "./hooks/useBackspaceGuard.ts";
import { quit } from "./shell.ts";
import { isNotifyEnabled, setNotifyEnabled } from "./notify.ts";
import { useTabs } from "./hooks/useTabs.ts";
import { EMPTY_DRAFT, useDrafts } from "./hooks/useDrafts.ts";
import { TabBar, type TabSummary } from "./components/TabBar.tsx";
import { CloseTabsDialog } from "./components/CloseTabsDialog.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { AppMenu } from "./components/AppMenu.tsx";
import { Modal } from "./components/Modal.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import { RecentSessionsModal } from "./components/RecentSessionsModal.tsx";
import {
  type SettingsCategory,
  SettingsModal,
} from "./components/SettingsModal.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { ServerDownBanner } from "./components/ServerDownBanner.tsx";
import { ModeSelectView } from "./components/ModeSelectView.tsx";
import { StellaView } from "./components/StellaView.tsx";
import { useAppMode } from "./hooks/useAppMode.ts";
import { useStella } from "./hooks/useStella.ts";
import { useRoutines } from "./hooks/useRoutines.ts";
import { StellaSidebar } from "./components/StellaSidebar.tsx";

export interface AppProps {
  /** Preloaded data from the bootstrap script; undefined when not served. */
  initialData?: InitialData;
}

/** A close operation waiting for the user's answer (CloseTabsDialog): the
 * tabs it targets, and the running ones among them — those are what the
 * dialog warns about and what "keep running" exempts from `POST /close`. */
interface PendingClose {
  ids: string[];
  running: Set<string>;
  /** Display names of the running tabs, in tab order. */
  names: string[];
}

export function App({ initialData }: AppProps): ReactElement {
  const t = useT();
  // Follow the visual viewport: the software keyboard on a phone shrinks it,
  // and the app shrinks with it so the composer stays reachable.
  useAppHeight();
  // Backspace outside a text field would navigate the WebView back (macOS
  // WebKit), reloading the app and discarding whatever is open — a settings
  // dialog with a half-typed server, for one.
  useBackspaceGuard();
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
  // Which mode the app is in, and whether stella can run on this server.
  // The mode gates the whole body below: unknown (no choice stored yet) shows
  // the selection screen, so neither mode's hooks run before its mode exists.
  const {
    status: modeStatus,
    loading: modeLoading,
    error: modeError,
    setMode,
  } = useAppMode();
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
  const {
    views,
    setViews,
    setViewError,
    seedRevision,
    resyncPanels,
    loadOlder,
    olderLoading,
  } = useSessionEvents({
    onConnectionLost: () => serverHealth.noteFailure(),
  });
  const {
    tabs,
    setTabs,
    activeTab,
    setActiveTab,
    openDraftTab,
    closeTabs,
    reopenSession,
  } = useTabs(setViews, seedRevision, resyncPanels);
  // Closing a tab closes its session, which stops the run (and the
  // session's background commands and sub-agents). A close that would do
  // that to a running tab therefore asks first (CloseTabsDialog); the
  // dialog's "keep running" answer closes the tab without the session.
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  /** Close the given tabs, asking first when one of them is running. */
  const requestClose = useCallback((ids: string[]) => {
    const running = ids.filter((id) => {
      const view = views.get(id);
      return view !== undefined && isViewRunning(view);
    });
    if (running.length === 0) {
      closeTabs(ids);
      return;
    }
    setPendingClose({
      ids,
      running: new Set(running),
      names: running.map((id) =>
        views.get(id)?.info.name || t("chrome.tabBar.newSession")
      ),
    });
  }, [views, closeTabs, t]);
  /** Answer the dialog: close the tabs, with the running sessions stopped
   * (`keepRunning` false) or left to finish on the server. */
  const resolveClose = (keepRunning: boolean) => {
    if (pendingClose === null) return;
    const { ids, running } = pendingClose;
    setPendingClose(null);
    closeTabs(ids, keepRunning ? running : undefined);
  };
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
  // The mode-selection screen, reopened from the app menu (the first-run
  // screen is driven by the stored mode instead; this is the "switch" path).
  const [showModeSelect, setShowModeSelect] = useState(false);
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

  // What the tab bar renders, derived here so its memoized component stays
  // out of the streaming hot path: the view map is replaced on every event,
  // while this list changes only when a label or a run state does.
  const tabSummaries = useMemo<TabSummary[]>(
    () =>
      tabs.map((id) => {
        const view = views.get(id);
        return {
          id,
          name: view?.info.name ?? null,
          modelId: view?.info.modelId ?? null,
          active: id === activeTab,
          running: view !== undefined && isViewRunning(view),
          runningTool: view?.runningTools.values().next().value as
            | string
            | undefined,
        };
      }),
    [tabs, views, activeTab],
  );
  // Stable callbacks (the memoized bar re-renders on their identity).
  const closeTab = useCallback(
    (id: string) => requestClose(closeTargets("tab", tabs, id)),
    [requestClose, tabs],
  );
  const closeTabsToRight = useCallback(
    (id: string) => requestClose(closeTargets("toRight", tabs, id)),
    [requestClose, tabs],
  );
  const closeTabsToLeft = useCallback(
    (id: string) => requestClose(closeTargets("toLeft", tabs, id)),
    [requestClose, tabs],
  );
  const closeOtherTabs = useCallback(
    (id: string) => requestClose(closeTargets("others", tabs, id)),
    [requestClose, tabs],
  );
  const openRecent = useCallback(() => setShowRecent(true), []);
  const openSettings = useCallback(() => setSettingsCategory("general"), []);

  // --- stella mode --------------------------------------------------------
  // The hook runs unconditionally (hooks cannot be conditional), but it only
  // acts when stella is the current mode: `enabled` gates its requests. A
  // stella conversation has its own endpoints and event stream (api-stella),
  // so it never enters the tab views above.
  const stellaActive = modeStatus?.mode === "stella";
  const stella = useStella(stellaActive);
  const stellaAgent = stella.agents.find((a) => a.id === stella.activeAgentId);
  // The settings dialog's routine list: the active agent's routines
  // (code mode has no agent, so the list stays empty and says so).
  const routines = useRoutines(stellaActive ? stella.activeAgentId : null);
  const routineAgentName = stellaActive ? stellaAgent?.name ?? null : null;

  // The mode-selection screen, and nothing else, until a mode is chosen.
  if (modeStatus === null || modeStatus.mode === null) {
    return (
      <div className="app" ref={appRef}>
        <AppMenu
          onNew={() => {}}
          onOpenRecent={openRecent}
          onOpenSettings={openSettings}
          onQuit={quit}
          onSwitchMode={() => setShowModeSelect(true)}
          isDesktop={update.source === "shell"}
          buttonClass="app-menu-standalone"
        />
        {modeLoading
          ? <div className="mode-select-loading">{t("common.loading")}</div>
          : modeStatus === null
          ? (
            <div className="mode-select-loading">
              {t("common.serverUnreachable", { error: modeError ?? "" })}
            </div>
          )
          : (
            <ModeSelectView
              status={modeStatus}
              error={modeError}
              busy={false}
              onChoose={(mode) => void setMode(mode)}
            />
          )}
      </div>
    );
  }

  return (
    <div className="app" ref={appRef}>
      {
        /* The desktop window is undecorated; the title bar strip holds the
       * tab bar, the app menu and the window controls (in a plain browser
       * the tab bar renders on its own). */
      }
      <TitleBar
        onNew={openDraftTab}
        onOpenRecent={openRecent}
        onOpenSettings={openSettings}
        onQuit={quit}
        onSwitchMode={() => setShowModeSelect(true)}
      >
        {stellaActive
          // stella mode has no tab strip: one conversation is the whole
          // surface, and an empty strip beside it would suggest otherwise.
          // The bar chrome is reused so the strip looks the same in a plain
          // browser (where the title bar renders no wrapper) as on desktop.
          ? <div className="tabbar stella-titlebar-label">stella</div>
          : (
            <TabBar
              tabs={tabSummaries}
              onSelect={setActiveTab}
              onClose={closeTab}
              onCloseToRight={closeTabsToRight}
              onCloseToLeft={closeTabsToLeft}
              onCloseOthers={closeOtherTabs}
              onNew={openDraftTab}
              onOpenRecent={openRecent}
              onOpenSettings={openSettings}
              isDesktop={update.source === "shell"}
              onQuit={quit}
              onSwitchMode={() => setShowModeSelect(true)}
            />
          )}
      </TitleBar>
      {/* Everything below the title bar. */}
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
        {stellaActive
          ? (
            // stella mode: the agents on the left, one conversation in
            // the middle, the machine's screen beside it. Rendered instead of
            // the tab branch (not beside it): a tab strip is exactly the
            // session-list surface this mode exists to remove.
            <div className="stella-shell">
              <StellaSidebar
                agents={stella.agents}
                activeId={stella.activeAgentId}
                onSelect={stella.select}
                onChanged={stella.reloadAgents}
              />
              <StellaView
                agent={stellaAgent === undefined
                  ? null
                  : { name: stellaAgent.name }}
                conversation={stella.conversation}
                sessionId={stella.sessionId}
                conversationError={stella.error}
                status={modeStatus}
                input={draft.input}
                onInputChange={(input) => updateDraft(draftKey, { input })}
                onPrompt={(text) => stella.prompt(text)}
                onAbort={() => stella.abort()}
                onRewind={(timestamp) => stella.rewind(timestamp)}
                onLoadOlder={stella.loadOlder}
                loadingOlder={stella.loadingOlder}
                onFinishHandover={(note, toolCallId) =>
                  stella.finishHandover(note, toolCallId)}
                onOpenSettings={() => setSettingsCategory("providers")}
              />
            </div>
          )
          : activeView
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
              onCardAnswer={(text) => activeTab && prompt(activeTab, text, [])}
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
              onLoadOlder={() => activeTab !== null && loadOlder(activeTab)}
              loadingOlder={activeTab !== null && olderLoading.has(activeTab)}
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
          routines={routines}
          routineAgent={routineAgentName}
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
      {pendingClose !== null && (
        <CloseTabsDialog
          names={pendingClose.names}
          onCancel={() => setPendingClose(null)}
          onStopAndClose={() => resolveClose(false)}
          onKeepRunning={() => resolveClose(true)}
        />
      )}
      {showModeSelect && modeStatus !== null && (
        <Modal onClose={() => setShowModeSelect(false)}>
          <ModeSelectView
            status={modeStatus}
            error={modeError}
            busy={false}
            onChoose={(mode) => {
              if (mode === modeStatus.mode) {
                setShowModeSelect(false);
                return;
              }
              void setMode(mode).then(
                () =>
                  setShowModeSelect(false),
                // A refusal (stella on a host without a usable machine) keeps
                // the dialog open showing its reason: closing it would hide
                // why nothing happened.
                () => {},
              );
            }}
          />
        </Modal>
      )}
    </div>
  );
}
