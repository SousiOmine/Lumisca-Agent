import {
  type ReactElement,
  useCallback,
  useEffect,
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
import { useNarrowViewport } from "./hooks/useMediaQuery.ts";
import { useSessionActions } from "./hooks/useSessionActions.ts";
import { useAppHeight } from "./hooks/useAppHeight.ts";
import { useBackspaceGuard } from "./hooks/useBackspaceGuard.ts";
import { inDesktopShell, quit, shellPlatform } from "./shell.ts";
import { isNotifyEnabled, setNotifyEnabled } from "./notify.ts";
import { useTabs } from "./hooks/useTabs.ts";
import { useTabClose } from "./hooks/useTabClose.ts";
import { EMPTY_DRAFT, useDrafts } from "./hooks/useDrafts.ts";
import { TabBar, type TabSummary } from "./components/TabBar.tsx";
import { CloseTabsDialog } from "./components/CloseTabsDialog.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { MacosTitleBarDrag } from "./components/MacosTitleBarDrag.tsx";
import { AppMenu } from "./components/AppMenu.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { NewSessionView } from "./components/NewSessionView.tsx";
import { RecentSessionsModal } from "./components/RecentSessionsModal.tsx";
import {
  type CommonSettingsCategory,
  SettingsModal,
} from "./components/SettingsModal.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { ServerDownBanner } from "./components/ServerDownBanner.tsx";
import { ModeGate, ModeGateDialog } from "./components/ModeGate.tsx";
import { StellaModeScreen } from "./components/StellaModeScreen.tsx";
import { StellaTitleBarHeader } from "./components/stella/StellaTitleBarHeader.tsx";
import { AgentEditDialog } from "./components/stella/AgentEditDialog.tsx";
import { useAppMode } from "./hooks/useAppMode.ts";
import { useStella } from "./hooks/useStella.ts";
import { usePush } from "./hooks/usePush.ts";
import { useRoutines } from "./hooks/useRoutines.ts";

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
    mode,
    status: machineStatus,
    error: modeError,
    setMode,
  } = useAppMode();
  // macOS overlays the native title bar on the page, so the page's chrome
  // has to start below it (see `.app.macos` in styles/chrome.css). The
  // platform is the shell's answer, injected with the bridge origin: a
  // remote server is displayed in the same window.
  const macos = shellPlatform === "macos";
  const appClass = macos ? "app macos" : "app";
  // Whether this page runs inside the desktop shell's window. The title bar
  // is drawn from this, not from an answer of the bridge: a window whose
  // controls vanished because one bridge call failed cannot be closed or
  // moved, which is the whole point of the controls.
  const desktop = inDesktopShell();
  const {
    workspaces,
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
    forgetRevisions,
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
  } = useTabs(setViews, seedRevision, resyncPanels, forgetRevisions);
  // Closing a tab closes its session, which stops the run (and the
  // session's background commands and sub-agents). A close that would do
  // that to a running tab therefore asks first (CloseTabsDialog, via
  // useTabClose).
  const tabClose = useTabClose({ views, closeTabs });
  const { request: requestClose, resolve: resolveClose } = tabClose;
  const pendingClose = tabClose.pending;

  // Unsent composer content per tab: the chat view remounts on every tab
  // switch (keyed below), so the draft lives here and is fed back into
  // the view when its tab is shown again. Closing a tab discards it.
  const { drafts, updateDraft, clearDraft } = useDrafts(tabs);
  // Which page the settings dialog opens on. Every caller opens a category
  // both modes have (the model picker opens プロバイダー, the app menu 一般,
  // the connection picker 接続先サーバー), so the type keeps a mode-only page
  // out of a prop the dialog could not honour.
  const [settingsCategory, setSettingsCategory] = useState<
    CommonSettingsCategory | null
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
  // PWA notifications of this device (Web Push). Read only while the settings
  // dialog is open: the page has no other use for the state, and asking the
  // browser for it on every start would be a permission-adjacent read nobody
  // asked for.
  const push = usePush(settingsCategory === "general");
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
  // so this list is rebuilt per event too — the bar compares it by value
  // (TabBar's sameTabBar) and re-renders only when a label or a run state
  // actually differs.
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
  // Stable callbacks: not because the bar re-renders on their identity (it
  // compares props by value, see TabBar), but so that the bar's comparison
  // stays a real one — an inline arrow would make every event look like a
  // change.
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
  const closeRecent = useCallback(() => setShowRecent(false), []);
  const openSettings = useCallback(() => setSettingsCategory("general"), []);
  const openProviders = useCallback(
    () => setSettingsCategory("providers"),
    [],
  );
  const openServers = useCallback(() => setSettingsCategory("servers"), []);
  const closePendingClose = tabClose.cancel;
  // The mode-selection screen, opened from the app menu ("switch mode") and
  // closed from its own modal. Both are plain setters with a fixed argument,
  // so they are stable for the memoized tab bar and the app menu alike: an
  // inline arrow would be a new function on every event the App re-renders
  // for, and TabBar's props would then never compare equal.
  const openModeSelect = useCallback(() => setShowModeSelect(true), []);
  const closeModeSelect = useCallback(() => setShowModeSelect(false), []);
  // Ctrl+T (the shortcut the app menu advertises): open the draft tab. Only
  // code mode has tabs; stella's conversation is the whole surface. The
  // handler is on the window because the shortcut must work from the
  // composer as well as from a transcript.
  useEffect(() => {
    if (mode !== "code") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "t") return;
      event.preventDefault();
      openDraftTab();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [mode, openDraftTab]);

  // --- stella mode --------------------------------------------------------
  // The hook runs unconditionally (hooks cannot be conditional), but it only
  // acts when stella is the current mode: `enabled` gates its requests. A
  // stella conversation has its own endpoints and event stream (api-stella),
  // so it never enters the tab views above.
  const stellaActive = mode === "stella";
  const stella = useStella(stellaActive);
  // stella's two surfaces are two columns on a desktop and two screens on a
  // phone (see the shell below). The query is the same 600px the stylesheet
  // switches at, so the layout and the navigation cannot disagree.
  const narrow = useNarrowViewport();
  const stellaAgent = stella.agents.find((a) => a.id === stella.activeAgentId);
  // The screen pane's switch and the edit dialog are opened from the title
  // bar, which this App draws (see StellaTitleBarHeader): their state is
  // here, above both the bar and the conversation it names.
  const [stellaScreenOpen, setStellaScreenOpen] = useState(false);
  const [editingStellaAgent, setEditingStellaAgent] = useState(false);
  const stellaHandedOver = stella.conversation?.handover !== null &&
    stella.conversation?.handover !== undefined;
  // The settings dialog's routine list: the active agent's routines
  // (code mode has no agent, so the list stays empty and says so).
  const routines = useRoutines(stellaActive ? stella.activeAgentId : null);
  const routineAgentName = stellaActive ? stellaAgent?.name ?? null : null;

  // The mode-selection screen, and nothing else, until this client picks a
  // mode. The choice is per client (hooks/useAppMode.ts), so a second window
  // on the same server is never dragged into it.
  if (mode === null) {
    return (
      <div className={appClass}>
        {macos && <MacosTitleBarDrag />}
        {
          /* The selection screen is the first thing a new origin shows, and
         * a remote server is a new origin (the mode is stored per client,
         * per origin). The window is undecorated there, so this screen has
         * to carry the same chrome as the app: without it a connected
         * window had no way to be moved, maximized or closed. */
        }
        <TitleBar
          onNew={openDraftTab}
          onOpenRecent={openRecent}
          onOpenSettings={openSettings}
          onQuit={quit}
          onSwitchMode={openModeSelect}
          onManageConnections={openServers}
          tabs={false}
        >
          <div className="titlebar-blank" />
        </TitleBar>
        {
          /* A plain browser has no title bar, so the menu stays where the
         * tab bar would put it: this screen is the only way into settings
         * and the mode switch before a mode exists. */
        }
        {!desktop && (
          <AppMenu
            onNew={openDraftTab}
            onOpenRecent={openRecent}
            onOpenSettings={openSettings}
            onQuit={quit}
            onSwitchMode={openModeSelect}
            isDesktop={false}
            buttonClass="app-menu-standalone"
          />
        )}
        <div className="app-body">
          {machineStatus === null
            ? (
              <div className="mode-select-loading">
                {modeError === null
                  ? t("common.loading")
                  : t("common.serverUnreachable", { error: modeError })}
              </div>
            )
            : (
              <ModeGate
                status={machineStatus}
                mode={mode}
                error={modeError}
                choose={setMode}
              />
            )}
        </div>
      </div>
    );
  }

  return (
    <div className={appClass}>
      {macos && <MacosTitleBarDrag />}
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
        onSwitchMode={openModeSelect}
        onManageConnections={openServers}
        tabs={!stellaActive}
      >
        {stellaActive
          // stella mode has no tab strip: one conversation is the whole
          // surface, so the strip names that conversation instead of listing
          // sessions. See StellaTitleBarHeader: the agent's face and name are
          // here because they were a second strip inside the sheet, saying
          // the same thing one line lower.
          ? (
            <div className="stella-titlebar-strip">
              <StellaTitleBarHeader
                agent={stellaAgent ?? null}
                machineRunning={machineStatus?.state === "running"}
                label={t(
                  narrow && stella.activeAgentId === null
                    ? "chat.stella.agents.title"
                    : "chat.stella.titleBarLabel",
                )}
                onBack={narrow && stella.activeAgentId !== null
                  ? stella.clearSelection
                  : undefined}
                onEditAgent={() => setEditingStellaAgent(true)}
                onToggleScreen={machineStatus?.state === "running" &&
                    !stellaHandedOver
                  ? () => setStellaScreenOpen((open) => !open)
                  : undefined}
                screenOpen={stellaScreenOpen}
              />
              {
                /* On desktop the app menu lives in the title bar's controls; in
               * a plain browser this strip is the only chrome stella mode
               * has, so the menu (settings, mode switch, session history)
               * has to stay reachable from here. */
              }
              {!desktop && (
                <div className="tabbar-actions">
                  <AppMenu
                    onNew={openDraftTab}
                    onOpenRecent={openRecent}
                    onOpenSettings={openSettings}
                    onQuit={quit}
                    onSwitchMode={openModeSelect}
                    isDesktop={false}
                    tabs={false}
                  />
                </div>
              )}
            </div>
          )
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
              isDesktop={desktop}
              onQuit={quit}
              onSwitchMode={openModeSelect}
            />
          )}
      </TitleBar>
      {/* Everything below the title bar. */}
      <div className="app-body">
        <UpdateBanner update={update} />
        <ServerDownBanner health={serverHealth} />
        {loadError && (
          <div className="msg">
            <div className="msg-body error-text">
              <p>{t("common.serverUnreachable", { error: loadError })}</p>
            </div>
          </div>
        )}
        {stellaActive
          ? (
            // stella mode: the agents, the open conversation and the
            // machine's screen (see StellaModeScreen). Rendered instead of
            // the tab branch (not beside it): a tab strip is exactly the
            // session-list surface this mode exists to remove.
            <StellaModeScreen
              stella={stella}
              agent={stellaAgent ?? null}
              status={machineStatus}
              narrow={narrow}
              input={draft.input}
              onInputChange={(input) => updateDraft(draftKey, { input })}
              images={draft.images}
              onImagesChange={(images) => updateDraft(draftKey, { images })}
              files={draft.files}
              onFilesChange={(files) => updateDraft(draftKey, { files })}
              onAgentChanged={stella.replaceAgent}
              onOpenSettings={openProviders}
              screenOpen={stellaScreenOpen}
              onScreenOpenChange={setStellaScreenOpen}
            />
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
                activeTab === null
                  ? Promise.resolve()
                  : prompt(activeTab, text, images, mode)}
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
              onOpenSettings={openProviders}
            />
          )
          : (
            <NewSessionView
              workspaces={workspaces}
              workspacesLoaded={workspacesLoaded}
              input={draft.input}
              onInputChange={(input) => updateDraft(draftKey, { input })}
              images={draft.images}
              onImagesChange={(images) => updateDraft(draftKey, { images })}
              onStart={async (workspace, model, text, images, mode) => {
                await startSession(workspace, model, text, images, mode);
                // The draft tab is replaced by the new session's tab; its
                // draft was sent, so discard it (kept on failure so the
                // user can retry).
                clearDraft(DRAFT_TAB);
              }}
              onWorkspaceChanged={handleWorkspaceChanged}
              onDeleteWorkspace={deleteWorkspace}
              onReopenSession={reopenSession}
              onOpenSettings={openProviders}
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
          push={push}
          initialCategory={settingsCategory}
          routines={routines}
          routineAgent={routineAgentName}
          mode={mode}
          onClose={closeSettings}
        />
      )}
      {showRecent && (
        <RecentSessionsModal
          openKeys={new Set(tabs)}
          onOpen={(key) => void reopenSession(key)}
          onClose={closeRecent}
        />
      )}
      {pendingClose !== null && (
        <CloseTabsDialog
          names={pendingClose.names}
          onCancel={closePendingClose}
          onStopAndClose={() => resolveClose(false)}
          onKeepRunning={() => resolveClose(true)}
        />
      )}
      {stellaActive && stellaAgent !== undefined && editingStellaAgent && (
        <AgentEditDialog
          agent={stellaAgent}
          onChanged={(updated) => {
            stella.replaceAgent(updated);
            setEditingStellaAgent(false);
          }}
          onClose={() => setEditingStellaAgent(false)}
        />
      )}
      {showModeSelect && (
        <ModeGateDialog
          status={machineStatus}
          mode={mode}
          error={modeError}
          choose={setMode}
          onClose={closeModeSelect}
        />
      )}
    </div>
  );
}
