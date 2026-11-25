import type { ReactElement } from "preact/compat";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { AppDialogs } from "./components/AppDialogs.tsx";
import { AppTitleBar, type TitleBarStrip } from "./components/AppTitleBar.tsx";
import { LoadingSkeleton } from "./components/LoadingSkeleton.tsx";
import { MacosTitleBarDrag } from "./components/MacosTitleBarDrag.tsx";
import { ServerDownBanner } from "./components/ServerDownBanner.tsx";
import { DraftPane, SessionPane } from "./components/SessionPane.tsx";
import { StellaModeScreen } from "./components/StellaModeScreen.tsx";
import { SetupScreen } from "./components/setup/SetupScreen.tsx";
import type { TabSummary } from "./components/TabBar.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { useAppHeight } from "./hooks/useAppHeight.ts";
import { codeUrl, useAppNavigation } from "./hooks/useAppNavigation.ts";
import { useBackspaceGuard } from "./hooks/useBackspaceGuard.ts";
import { useBuildWatch } from "./hooks/useBuildWatch.ts";
import { EMPTY_DRAFT, useDrafts } from "./hooks/useDrafts.ts";
import { useCompactViewport } from "./hooks/useMediaQuery.ts";
import { useServerHealth } from "./hooks/useServerHealth.ts";
import {
  type SessionActions,
  useSessionActions,
} from "./hooks/useSessionActions.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useSettingsDialog } from "./hooks/useSettingsDialog.ts";
import { useSetup } from "./hooks/useSetup.ts";
import { useStella } from "./hooks/useStella.ts";
import { useTabClose } from "./hooks/useTabClose.ts";
import { useTabs } from "./hooks/useTabs.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useT } from "./i18n.ts";
import { inDesktopShell, shellPlatform } from "./shell.ts";
import { closeTargets, DRAFT_TAB } from "./tabs.ts";
import type { InitialData } from "./types.ts";
import { isViewRunning } from "./types.ts";

export interface AppProps {
  /** Preloaded data from the bootstrap script; undefined when not served. */
  initialData?: InitialData;
}

/**
 * The app: the composition point of the two modes' bodies, the window's
 * chrome and the dialogs.
 *
 * What it does NOT own is as much of the design as what it does. Where the
 * app is — the address, the mode it shows, the settings dialog's page on the
 * screen underneath — is hooks/useAppNavigation; the settings dialog's values
 * are hooks/useSettingsDialog; the strip is components/AppTitleBar. What is
 * left here is the wiring of the session and conversation state into those
 * three, which is the wiring that decides what a reader sees on each screen.
 */
export function App({ initialData }: AppProps): ReactElement {
  const t = useT();
  // Follow the visual viewport: the software keyboard on a phone shrinks it,
  // and the app shrinks with it so the composer stays reachable.
  useAppHeight();
  // Backspace outside a text field would navigate the WebView back (macOS
  // WebKit), reloading the app and discarding whatever is open — a settings
  // dialog with a half-typed server, for one.
  useBackspaceGuard();
  // The installation's first-run setup. The page is seeded with the answer
  // (InitialData.setup, read by the server from the marker file beside the
  // settings file), so `/` can be sent to the wizard before anything else is
  // drawn; `complete` is the one action that ends it.
  const setup = useSetup(initialData?.setup);
  // The address, the mode it shows, and every move to another screen. The
  // setup's answer decides where `/` goes, so it is read first.
  const nav = useAppNavigation({ setupPending: setup.pending });
  const { route, mode } = nav;
  // The settings dialog's values (this device's theme and language, the
  // installation's update and push state) and the props they make. The
  // wizard edits the same two preferences, hence the theme and language out.
  const settingsUi = useSettingsDialog({
    settings: nav.settings,
    onOpenCategory: nav.openSettingsAt,
    onBackToList: nav.backToSettingsList,
    onClose: nav.closeSettings,
  });

  // macOS overlays the native title bar on the page, so the page's chrome
  // has to start below it (see `.app.macos` in styles/chrome.css). The
  // platform is the shell's answer, injected with the bridge origin: a
  // remote server is displayed in the same window.
  const macos = shellPlatform() === "macos";
  // Whether this page runs inside the desktop shell's window. The title bar
  // is drawn from this, not from an answer of the bridge: a window whose
  // controls vanished because one bridge call failed cannot be closed or
  // moved, which is the whole point of the controls.
  const desktop = inDesktopShell();
  // The class says a title bar is part of the page: surfaces that can cover
  // the window keep its drag strip clear (see .stella-pane.fullscreen).
  const appClass = `${macos ? "app macos" : "app"}${desktop ? " desktop" : ""}`;
  // Whether the server has moved on from the client bundle this page loaded.
  // Fast enough to notice the successor answering once this page asked for a
  // restart — that answer is the moment this page reloads.
  const build = useBuildWatch(initialData?.buildId, {
    restartPending: settingsUi.update.restartRequested,
  });
  useEffect(() => {
    // The restart this page asked for has finished: the new server serves a
    // new client, and this page would keep describing the previous release.
    if (build.stale && settingsUi.update.restartRequested) location.reload();
  }, [build.stale, settingsUi.update.restartRequested]);
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

  // --- code mode: the tab the address names --------------------------------
  /** The session the address names, or null for the new-session screen. */
  const activeTab: string | null = route.kind === "code" ? route.tabKey : null;
  const { goToTab } = nav;
  // A session the address names but this page cannot open (it was deleted,
  // or the peer that owns it stopped answering) is not a screen: the reader
  // lands where they came from — the new-session screen — rather than on an
  // error they cannot act on.
  const tabsControl = useTabs(
    setViews,
    seedRevision,
    resyncPanels,
    forgetRevisions,
    activeTab,
    useCallback(() => nav.replace(codeUrl(null)), [nav.replace]),
  );
  const { open: openSessions, strip: tabs, adopt } = tabsControl;
  // Closing a tab closes its session, which stops the run (and the
  // session's background commands and sub-agents). A close that would do
  // that to a running tab therefore asks first (CloseTabsDialog). Either
  // answer ends on the same screen rule: closing is a command to the server
  // AND the end of a screen, so the address cannot keep naming what was
  // just closed.
  //
  // The navigation runs BEFORE the close: `closeTabs` drops the tab and its
  // view, and a body rendered against an address that still named it would
  // show the wait for a session that is being closed.
  const closeAndLeave = useCallback(
    (ids: string[], keepRunning?: ReadonlySet<string>) => {
      const shown = activeTab ?? DRAFT_TAB;
      if (ids.includes(shown)) {
        const remaining = tabs.filter(
          (id) => id !== DRAFT_TAB && id !== shown && !ids.includes(id),
        );
        nav.replace(codeUrl(remaining.at(-1) ?? null));
      }
      tabsControl.closeTabs(ids, keepRunning);
    },
    [activeTab, tabs, tabsControl, nav.replace],
  );
  const tabClose = useTabClose({ views, closeTabs: closeAndLeave });
  const pendingClose = tabClose.pending;

  // Unsent composer content per tab: a pane keeps its composer mounted now,
  // but the draft still lives here — closing a tab discards what was typed in
  // it, and the App is what owns "which tabs are open" (see useDrafts).
  const { drafts, updateDraft, clearDraft } = useDrafts(openSessions);
  const [showRecent, setShowRecent] = useState(false);
  /** A session was created and its first prompt was sent: the tab appears and
   * the address moves to it. Stable, so every action built on it is stable
   * too (the panes are memoized, see SessionPane). */
  const onSessionCreated = useCallback(
    (key: string) => {
      adopt(key);
      goToTab(key);
    },
    [adopt, goToTab],
  );
  const {
    startSession,
    prompt,
    abort,
    answer,
    rewind,
    compact,
    changeModel,
    changeThinkingLevel,
  } = useSessionActions({
    setViews,
    setViewError,
    // A session this page just created already has its view (see
    // startSession), so it is adopted rather than read back: the read would
    // replace an empty transcript with an empty transcript, and put the tab
    // in the strip only after a round trip. Stable, so startSession is too (a
    // new identity per render would re-render every pane, see SessionPane).
    onCreated: onSessionCreated,
  });
  /** One object for every session pane. Rebuilt only when an action is, so the
   * memoized panes of tabs nobody is looking at are not re-rendered on every
   * streamed event. */
  const sessionActions = useMemo<SessionActions>(
    () => ({
      prompt,
      abort,
      answer,
      rewind,
      compact,
      changeModel,
      changeThinkingLevel,
    }),
    [prompt, abort, answer, rewind, compact, changeModel, changeThinkingLevel],
  );
  /** The panes to draw, in tab order: every open session whose view has
   * arrived. A session the address names but this page has never read has no
   * pane yet, and the body shows the wait for it instead (below). */
  const panes = useMemo(
    () => openSessions.filter((key) => views.has(key)),
    [openSessions, views],
  );
  /** Whether the address is naming a pane this body draws. */
  const activePane = activeTab !== null && panes.includes(activeTab);
  // The draft tab (and the equivalent draft screen shown while no tab is
  // open) keeps its unsent input under the draft-tab key.
  const draftKey = activeTab ?? DRAFT_TAB;
  const draft = drafts.get(draftKey) ?? EMPTY_DRAFT;
  // The new-session screen is mounted the first time its address is shown and
  // then kept while the page lives (see DraftPane), so returning to it is the
  // same attribute change as any other tab. A launch that opens a session
  // directly still mounts it never, and so makes none of its reads.
  const [draftPaneMounted, setDraftPaneMounted] = useState(
    mode === "code" && activeTab === null,
  );
  useEffect(() => {
    if (mode === "code" && activeTab === null) setDraftPaneMounted(true);
  }, [mode, activeTab]);
  // Shown while the draft is the screen even before the latch above has been
  // set: closing the last tab lands here in the same render, and a body with
  // neither a pane nor the draft screen would be blank for a frame.
  const draftPaneShown = draftPaneMounted || activeTab === null;

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
          active: id === (activeTab ?? DRAFT_TAB),
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
  // change. A tab is a place: selecting one is a navigation.
  const newTab = useCallback(() => goToTab(null), [goToTab]);
  const selectTab = useCallback(
    (id: string) => goToTab(id === DRAFT_TAB ? null : id),
    [goToTab],
  );
  const closeTab = useCallback(
    (id: string) => tabClose.request(closeTargets("tab", tabs, id)),
    [tabClose, tabs],
  );
  // Desktop code mode: Ctrl/Cmd+W closes the active session tab instead of
  // closing the whole window. Left alone in plain browsers where Ctrl/Cmd+W
  // belongs to the browser's own tab strip.
  useEffect(() => {
    if (!desktop || mode !== "code" || activeTab === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "w") return;
      event.preventDefault();
      closeTab(activeTab);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [desktop, mode, activeTab, closeTab]);
  const closeTabsToRight = useCallback(
    (id: string) => tabClose.request(closeTargets("toRight", tabs, id)),
    [tabClose, tabs],
  );
  const closeTabsToLeft = useCallback(
    (id: string) => tabClose.request(closeTargets("toLeft", tabs, id)),
    [tabClose, tabs],
  );
  const closeOtherTabs = useCallback(
    (id: string) => tabClose.request(closeTargets("others", tabs, id)),
    [tabClose, tabs],
  );
  const openRecent = useCallback(() => setShowRecent(true), []);
  const closeRecent = useCallback(() => setShowRecent(false), []);

  // --- stella mode --------------------------------------------------------
  // The hook runs unconditionally (hooks cannot be conditional), but it only
  // acts when stella is the current mode: `enabled` gates its requests. A
  // stella conversation has its own endpoints and event stream (api-stella),
  // so it never enters the tab views above.
  const stellaActive = mode === "stella";
  /** The conversation the address names, or null for the agent list. */
  const stellaAgentId = route.kind === "stella" ? route.agentId : null;
  const stella = useStella(stellaActive, stellaAgentId);
  // An address naming a conversation that does not exist (deleted here or in
  // another window) is the list: an empty conversation screen would say the
  // agent is there and silent. The list is awaited first — before it lands,
  // "no such agent" and "not read yet" look the same. A freshly created agent
  // never reaches this branch: its row is put into the list from the create's
  // own answer before the address names it (see StellaSidebar).
  useEffect(() => {
    if (!stellaActive || stellaAgentId === null || stella.agentsLoading) {
      return;
    }
    if (stella.agents.some((agent) => agent.id === stellaAgentId)) return;
    nav.replace({ route: { kind: "stella", agentId: null }, settings: null });
  }, [
    stellaActive,
    stellaAgentId,
    stella.agentsLoading,
    stella.agents,
    nav.replace,
  ]);
  // stella's two surfaces are two columns on a desktop and two screens at the
  // compact width and below: a tablet held upright is 800-834px wide, where
  // the list beside the conversation leaves the conversation a phone's width
  // (stella.css). The query is the same 900px the stylesheet switches at, so
  // the layout and the navigation cannot disagree. What it decides here is the
  // title bar's way back to the list (there is none where the list is still a
  // column) and, in hooks/useRoute, whether the move is a page transition.
  const stellaSingleScreen = useCompactViewport();
  const stellaAgent = stella.agents.find((a) => a.id === stellaAgentId);
  // The screen pane's switch and the agent dialogs are opened from the title
  // bar, which this App draws (see AppTitleBar): their state is here, above
  // both the bar and the conversation it names. The create dialog is opened
  // from two places — the sidebar's button at wide widths and the bar's at
  // phone widths, where the list and the conversation are one screen each —
  // so it cannot belong to either.
  const [stellaScreenOpen, setStellaScreenOpen] = useState(false);
  const [editingStellaAgent, setEditingStellaAgent] = useState(false);
  const [creatingStellaAgent, setCreatingStellaAgent] = useState(false);
  const stellaHandedOver =
    stella.conversation?.handover !== null &&
    stella.conversation?.handover !== undefined;

  /** The app-level actions both menus offer: the tab bar's in code mode, the
   * strip's own in stella mode, and the desktop title bar's in both. */
  const titleBarActions = {
    onNew: newTab,
    onOpenRecent: openRecent,
    onOpenSettings: nav.openSettings,
    onSwitchMode: nav.switchMode,
    onManageConnections: nav.openServers,
  };
  /** What fills the strip beside the app menu: the tab bar, the conversation's
   * header, or nothing at all (the wizard has neither to name). */
  const titleBarStrip: TitleBarStrip = stellaActive
    ? {
        kind: "stella",
        agent: stellaAgent ?? null,
        agentId: stellaAgentId,
        singleScreen: stellaSingleScreen,
        onBack: nav.goToStellaList,
        onEditAgent: () => setEditingStellaAgent(true),
        // A disabled agent has no screen to show: its desktop was given back
        // when it was switched off, and asking for it would start the one
        // this state releases.
        onToggleScreen:
          !stellaHandedOver &&
          stellaAgentId !== null &&
          stellaAgent !== undefined &&
          stellaAgent.disabledAt === null
            ? () => setStellaScreenOpen((open) => !open)
            : undefined,
        screenOpen: stellaScreenOpen,
        onCreateAgent: () => setCreatingStellaAgent(true),
      }
    : {
        kind: "tabs",
        tabs: tabSummaries,
        onSelect: selectTab,
        onClose: closeTab,
        onCloseToRight: closeTabsToRight,
        onCloseToLeft: closeTabsToLeft,
        onCloseOthers: closeOtherTabs,
      };
  /** The setup screen's dialogs: the settings dialog only. Its title bar menu
   * opens that one, and nothing else has anything to name while the
   * installation has no conversation yet (a session list, a close prompt and
   * the agent editors are the app's, not the wizard's). */
  const setupDialogs = {
    settings: settingsUi.settingsDialog,
    recent: null,
    close: null,
    agentCreate: null,
    agentEdit: null,
  };

  // The first-run setup, as a screen of its own (`/setup`): while it shows,
  // there is nothing behind it to draw — the visitor arriving here has no
  // conversations yet — and a layer over a session would claim that session
  // is somewhere to be. The address says which screen this is, so a reload
  // keeps it (until the setup is finished, when useAppNavigation sends the
  // reader on).
  if (route.kind === "setup") {
    return (
      <div className={appClass}>
        {macos && <MacosTitleBarDrag />}
        {/* The same chrome as the app: the window is undecorated, so this
         * screen has to be movable, closable and switchable too. The strip
         * has no tab bar to hold. */}
        <AppTitleBar
          mode={mode}
          desktop={desktop}
          actions={titleBarActions}
          strip={{ kind: "blank" }}
        />
        <div className="app-body">
          {setup.pending && (
            <SetupScreen
              desktop={desktop}
              theme={settingsUi.theme}
              onThemeChange={settingsUi.setTheme}
              language={settingsUi.language}
              languageError={settingsUi.languageError}
              onLanguageChange={settingsUi.setLanguage}
              busy={setup.busy}
              error={setup.error}
              onComplete={setup.complete}
            />
          )}
          {/* The settings dialog only: its title bar menu opens that one, and
           * nothing else has anything to name while the installation has no
           * conversation yet (a session list, a close prompt and the agent
           * editors are the app's, not the wizard's). */}
          <AppDialogs {...setupDialogs} />
        </div>
      </div>
    );
  }
  return (
    <div className={appClass}>
      {macos && <MacosTitleBarDrag />}
      {/* The desktop window is undecorated; the title bar strip holds the
       * tab bar, the app menu and the window controls (in a plain browser
       * the tab bar renders on its own). */}
      <AppTitleBar
        mode={mode}
        desktop={desktop}
        actions={titleBarActions}
        strip={titleBarStrip}
      />
      {/* Everything below the title bar. */}
      <div className="app-body">
        <UpdateBanner update={settingsUi.update} stale={build.stale} />
        <ServerDownBanner health={serverHealth} />
        {loadError && (
          <div className="msg">
            <div className="msg-body error-text">
              <p>{t("common.serverUnreachable", { error: loadError })}</p>
            </div>
          </div>
        )}
        {nav.refusedStella !== null && (
          <div className="msg">
            <div className="msg-body">
              <p className="error-text" role="alert">
                {t("chat.stella.refused", { reason: nav.refusedStella })}
              </p>
              <button
                type="button"
                className="btn"
                onClick={nav.dismissRefusedStella}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        )}
        {stellaActive ? (
          // stella mode: the agents, the open conversation and the
          // machine's screen (see StellaModeScreen). Rendered instead of
          // the tab branch (not beside it): a tab strip is exactly the
          // session-list surface this mode exists to remove.
          <StellaModeScreen
            stella={stella}
            agent={stellaAgent ?? null}
            status={nav.machineStatus}
            input={draft.input}
            onInputChange={(input) => updateDraft(draftKey, { input })}
            images={draft.images}
            onImagesChange={(images) => updateDraft(draftKey, { images })}
            files={draft.files}
            onFilesChange={(files) => updateDraft(draftKey, { files })}
            onAgentChanged={stella.applyAgent}
            onNewAgent={() => setCreatingStellaAgent(true)}
            onSelectAgent={nav.goToStellaAgent}
            onOpenSettings={nav.openProviders}
            screenOpen={stellaScreenOpen}
            onScreenOpenChange={setStellaScreenOpen}
          />
        ) : (
          // One pane per open tab, all of them mounted: the tab the address
          // does not name is hidden, not rebuilt, so switching costs an
          // attribute rather than a transcript (see SessionPane). The draft
          // screen is the last pane and is mounted once it has been shown.
          <>
            {panes.map((key) => {
              const view = views.get(key);
              // A pane exists only once its view has landed; the address
              // reaches this page before the read does.
              if (view === undefined) return null;
              return (
                <SessionPane
                  key={key}
                  tabKey={key}
                  view={view}
                  active={key === activeTab}
                  draft={drafts.get(key) ?? EMPTY_DRAFT}
                  loadingOlder={olderLoading.has(key)}
                  actions={sessionActions}
                  loadOlder={loadOlder}
                  updateDraft={updateDraft}
                  onOpenSettings={nav.openProviders}
                />
              );
            })}
            {draftPaneShown && (
              <DraftPane
                active={activeTab === null}
                draft={drafts.get(DRAFT_TAB) ?? EMPTY_DRAFT}
                workspaces={workspaces}
                workspacesLoaded={workspacesLoaded}
                settingsVersion={settingsUi.settingsVersion}
                updateDraft={updateDraft}
                clearDraft={clearDraft}
                startSession={startSession}
                onWorkspaceChanged={handleWorkspaceChanged}
                onDeleteWorkspace={deleteWorkspace}
                onReopenSession={goToTab}
                onOpenSettings={nav.openProviders}
              />
            )}
            {activeTab !== null && !activePane && (
              // The address names a session this page has not drawn yet (a
              // bookmark, a reload, a link followed from elsewhere). Its
              // read is in flight, so the body says so rather than flashing
              // the new-session screen under the address of a session.
              <div className="chat-empty">
                <div className="chat-empty-inner">
                  <LoadingSkeleton label={t("common.loading")} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <AppDialogs
        settings={settingsUi.settingsDialog}
        recent={
          showRecent
            ? {
                // Every session tab this page has open; the draft tab is not a
                // session (it is the new-session screen, which every closed
                // session's re-open leaves anyway).
                openKeys: new Set(openSessions),
                onOpen: (key) => {
                  goToTab(key);
                  setShowRecent(false);
                },
                onClose: closeRecent,
              }
            : null
        }
        close={
          pendingClose !== null
            ? {
                names: pendingClose.names,
                onCancel: tabClose.cancel,
                onStopAndClose: () => tabClose.resolve(false),
                onKeepRunning: () => tabClose.resolve(true),
              }
            : null
        }
        agentCreate={
          stellaActive && creatingStellaAgent
            ? {
                onCreated: (agent) => {
                  // The row goes into the list before the address names it
                  // (see AgentCreateDialog).
                  stella.applyAgent(agent);
                  setCreatingStellaAgent(false);
                  nav.goToStellaAgent(agent.id);
                },
                onClose: () => setCreatingStellaAgent(false),
              }
            : null
        }
        agentEdit={
          stellaActive && stellaAgent !== undefined && editingStellaAgent
            ? {
                agent: stellaAgent,
                onChanged: (updated) => {
                  stella.applyAgent(updated);
                  setEditingStellaAgent(false);
                },
                onClose: () => setEditingStellaAgent(false),
              }
            : null
        }
      />
    </div>
  );
}
