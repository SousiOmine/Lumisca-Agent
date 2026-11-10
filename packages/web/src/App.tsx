import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/compat";
import type { AppMode } from "@lumisca/core/shared";
import type { InitialData } from "./types.ts";
import { isViewRunning } from "./types.ts";
import { closeTargets, DRAFT_TAB } from "./tabs.ts";
import type { UrlState } from "./route.ts";
import { useRoute } from "./hooks/useRoute.ts";
import { useT } from "./i18n.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useLanguage } from "./hooks/useLanguage.ts";
import { useWorkspaces } from "./hooks/useWorkspaces.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { useServerHealth } from "./hooks/useServerHealth.ts";
import { useBuildWatch } from "./hooks/useBuildWatch.ts";
import { useUpdateStatus } from "./hooks/useUpdateStatus.ts";
import { useCompactViewport } from "./hooks/useMediaQuery.ts";
import {
  type SessionActions,
  useSessionActions,
} from "./hooks/useSessionActions.ts";
import { useAppHeight } from "./hooks/useAppHeight.ts";
import { useBackspaceGuard } from "./hooks/useBackspaceGuard.ts";
import { inDesktopShell, quit, shellPlatform } from "./shell.ts";
import { isNotifyEnabled, setNotifyEnabled } from "./notify.ts";
import { useTabs } from "./hooks/useTabs.ts";
import { useTabClose } from "./hooks/useTabClose.ts";
import { EMPTY_DRAFT, useDrafts } from "./hooks/useDrafts.ts";
import { TabBar, type TabSummary } from "./components/TabBar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { MacosTitleBarDrag } from "./components/MacosTitleBarDrag.tsx";
import { AppMenu } from "./components/AppMenu.tsx";
import { DraftPane, SessionPane } from "./components/SessionPane.tsx";
import type { SettingsCategory } from "./components/SettingsModal.tsx";
import { AppDialogs } from "./components/AppDialogs.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { ServerDownBanner } from "./components/ServerDownBanner.tsx";
import { ModeGate } from "./components/ModeGate.tsx";
import { StellaModeScreen } from "./components/StellaModeScreen.tsx";
import { StellaTitleBarHeader } from "./components/stella/StellaTitleBarHeader.tsx";
import { rememberMode, storedMode, useAppMode } from "./hooks/useAppMode.ts";
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

/** The address of a mode's top screen. */
function modeTop(mode: AppMode): UrlState {
  return {
    route: mode === "code"
      ? { kind: "code", tabKey: null }
      : { kind: "stella", agentId: null },
    settings: null,
  };
}

/** The address of one code-mode tab (`null` = the new-session screen). The
 * settings dialog is never open on a tab move: it covers the screen it was
 * opened from, and moving to another one closes it. */
function codeUrl(tabKey: string | null): UrlState {
  return { route: { kind: "code", tabKey }, settings: null };
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
  // The address the app is showing. Every screen below is read from it, and
  // every move writes it back: the URL is the one answer to "where am I", so
  // a reload, a bookmark and the back button all agree. The mode chooser is
  // the one address that has no screen of its own — see the resolution below.
  const router = useRoute();
  const url = router.state;
  const { push: pushUrl, replace: replaceUrl } = router;
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

  // Which mode this page shows. The address names it, except at `/`: that is
  // the address the desktop shell and an installed PWA open, and it resolves
  // to the mode this client showed last. `null` means the chooser — no mode
  // has ever been chosen here, so there is nothing to resolve to.
  //
  // Memoized on the route kind: the store is a `localStorage` read, and the
  // App re-renders on every streamed event of a conversation.
  const resolved = useMemo(storedMode, [url.route.kind]);
  const mode: AppMode | null = url.route.kind === "modeSelect"
    ? resolved
    : url.route.kind;
  // The resolution is a REPLACE: `/` is not a place to come back to, and a
  // back from a mode's top must leave the app rather than bounce off the
  // chooser it never meant to show.
  useEffect(() => {
    if (url.route.kind !== "modeSelect" || mode === null) return;
    replaceUrl(modeTop(mode));
  }, [url.route.kind, mode, replaceUrl]);
  // Showing a mode is what this client remembers for the next bare `/` —
  // whether it was chosen here or arrived at through an address.

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
  // What this server can do for stella mode, and how its machine is doing.
  const appMode = useAppMode(mode);
  const machineStatus = appMode.status;
  /** A refusal the reader arrived at through an address (the chooser is not
   * where the choice was made, so nothing came to show it). */
  const [refusedStella, setRefusedStella] = useState<string | null>(null);
  // A mode whose whole premise is a virtual machine has no honest degraded
  // form: an address that names stella on a server that cannot run it lands
  // on code mode's top, with the reason on screen.
  useEffect(() => {
    if (mode !== "stella") return;
    if (machineStatus === null) return;
    if (machineStatus.availability.available) {
      // The machine came up (or another server answered): the sentence
      // describes a state that no longer holds.
      setRefusedStella(null);
      return;
    }
    setRefusedStella(machineStatus.availability.reason);
    replaceUrl(codeUrl(null));
  }, [mode, machineStatus, replaceUrl]);
  // Showing a mode is what this client remembers for the next bare `/` —
  // whether it was chosen here or arrived at through an address. The mode is
  // remembered only once the server has accepted it: a refused stella would
  // otherwise be the answer every launch, and the reader would meet the same
  // refusal instead of starting where they can work.
  useEffect(() => {
    if (mode === null) return;
    if (mode === "stella" && machineStatus === null) return;
    if (mode === "stella" && !machineStatus?.availability.available) return;
    rememberMode(mode);
  }, [mode, machineStatus]);
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
  const activeTab: string | null = url.route.kind === "code"
    ? url.route.tabKey
    : null;
  const goToTab = useCallback(
    (key: string | null) => pushUrl(codeUrl(key)),
    [pushUrl],
  );
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
    useCallback(() => replaceUrl(codeUrl(null)), [replaceUrl]),
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
  const closeAndLeave = useCallback((
    ids: string[],
    keepRunning?: ReadonlySet<string>,
  ) => {
    const shown = activeTab ?? DRAFT_TAB;
    if (ids.includes(shown)) {
      const remaining = tabs.filter((id) =>
        id !== DRAFT_TAB && id !== shown && !ids.includes(id)
      );
      replaceUrl(codeUrl(remaining.at(-1) ?? null));
    }
    tabsControl.closeTabs(ids, keepRunning);
  }, [activeTab, tabs, tabsControl, replaceUrl]);
  const tabClose = useTabClose({ views, closeTabs: closeAndLeave });
  const pendingClose = tabClose.pending;

  // Unsent composer content per tab: a pane keeps its composer mounted now,
  // but the draft still lives here — closing a tab discards what was typed in
  // it, and the App is what owns "which tabs are open" (see useDrafts).
  const { drafts, updateDraft, clearDraft } = useDrafts(openSessions);
  // Background agent-event notifications (desktop only): the event hook
  // reads the persisted value directly, so this state only drives the
  // settings toggle.
  const [notifyEnabled, setNotifyEnabledState] = useState(isNotifyEnabled);
  // The settings dialog is part of the address (`…/settings/<category>`), so
  // "what is open" and "what closing returns to" are both read from the URL.
  // PWA notifications of this device (Web Push) are read only while it is
  // open: the page has no other use for the state, and asking the browser
  // for it on every start would be a permission-adjacent read nobody asked
  // for.
  const settingsRoute = url.settings;
  const settingsOpen = settingsRoute !== null;
  const push = usePush(settingsOpen);
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
  // Whether the server has moved on from the client bundle this page loaded.
  // Fast enough to notice the successor answering once this page asked for a
  // restart — that answer is the moment this page reloads.
  const build = useBuildWatch(initialData?.buildId, {
    restartPending: update.restartRequested,
  });
  useEffect(() => {
    // The restart this page asked for has finished: the new server serves a
    // new client, and this page would keep describing the previous release.
    if (build.stale && update.restartRequested) location.reload();
  }, [build.stale, update.restartRequested]);
  /** A session was created and its first prompt was sent: the tab appears and
   * the address moves to it. Stable, so every action built on it is stable
   * too (the panes are memoized, see SessionPane). */
  const onSessionCreated = useCallback((key: string) => {
    adopt(key);
    goToTab(key);
  }, [adopt, goToTab]);
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
  const selectTab = useCallback(
    (id: string) => goToTab(id === DRAFT_TAB ? null : id),
    [goToTab],
  );
  const closeTab = useCallback(
    (id: string) => tabClose.request(closeTargets("tab", tabs, id)),
    [tabClose, tabs],
  );
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
  // Settings are part of the address (see route.ts), so opening one is a
  // history entry: closing it returns to the screen it covered — the
  // session, the conversation, the draft — without the app remembering it.
  // The app menu's way in names no category: the dialog then picks its first
  // screen for the layout it gets.
  //
  // The current address is read from a ref, so the openers stay stable: the
  // tab bar and the app menu compare their props by value, and an opener
  // rebuilt per navigation would make the memoized bar re-render. The ref is
  // written in an effect, not during render (concurrent rendering).
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);
  const openSettingsAt = useCallback((category: SettingsCategory | null) => {
    pushUrl({ ...urlRef.current, settings: { category } });
  }, [pushUrl]);
  // Every opener is a stable callback with a fixed argument: the tab bar and
  // the app menu compare their props by value.
  const openSettings = useCallback(
    () => openSettingsAt(null),
    [openSettingsAt],
  );
  const openProviders = useCallback(
    () => openSettingsAt("providers"),
    [openSettingsAt],
  );
  const openServers = useCallback(
    () => openSettingsAt("servers"),
    [openSettingsAt],
  );
  /** Close the dialog. Modal calls this once, after its exit has run, so the
   * move is the last thing the reader sees. */
  const closeSettings = useCallback(() => {
    router.dismiss({ ...urlRef.current, settings: null });
  }, [router]);
  /** Back from a category page to the category list (the dialog's own back
   * button on a narrow window). A pop for the same reason as stella's: the
   * list is the screen the reader came from, so the button and the browser's
   * back are one move — and the transition draws the direction from it. The
   * dialog itself stays open: the address keeps `settings`, only its category
   * goes. */
  const backToSettingsList = useCallback(() => {
    router.dismiss({ ...urlRef.current, settings: { category: null } });
  }, [router]);
  // Bumped when the settings dialog closes: the draft re-reads the default
  // model there, since registering (or removing) a provider changes what a
  // new session would run on. A dialog without a provider change only costs
  // one cheap request.
  const [settingsVersion, setSettingsVersion] = useState(0);
  const settingsWasOpen = useRef(settingsOpen);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen) {
      setSettingsVersion((version) => version + 1);
    }
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen]);
  // The mode-selection screen, opened from the app menu ("switch mode") and
  // closed from its own modal. Both are plain setters with a fixed argument,
  // so they are stable for the memoized tab bar and the app menu alike: an
  // inline arrow would be a new function on every event the App re-renders
  // for, and TabBar's props would then never compare equal.
  const openModeSelect = useCallback(() => setShowModeSelect(true), []);
  const closeModeSelect = useCallback(() => setShowModeSelect(false), []);
  /** Choose a mode: the server's verdict first (stella may be refused), then
   * the address. It REPLACES: the screen it is chosen from is the chooser,
   * and `/` resolves to the very mode just chosen, so a back would bounce
   * through it instead of leaving. */
  const chooseMode = useCallback(async (next: AppMode) => {
    await appMode.choose(next);
    replaceUrl(modeTop(next));
  }, [appMode, replaceUrl]);
  // Ctrl+T (the shortcut the app menu advertises): open the draft tab. Only
  // code mode has tabs; stella's conversation is the whole surface. The
  // handler is on the window because the shortcut must work from the
  // composer as well as from a transcript.
  useEffect(() => {
    if (mode !== "code") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "t") return;
      event.preventDefault();
      goToTab(null);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [mode, goToTab]);

  // --- stella mode --------------------------------------------------------
  // The hook runs unconditionally (hooks cannot be conditional), but it only
  // acts when stella is the current mode: `enabled` gates its requests. A
  // stella conversation has its own endpoints and event stream (api-stella),
  // so it never enters the tab views above.
  const stellaActive = mode === "stella";
  /** The conversation the address names, or null for the agent list. */
  const stellaAgentId = url.route.kind === "stella" ? url.route.agentId : null;
  const stella = useStella(stellaActive, stellaAgentId);
  // Back to the list. A pop, not a push: the list is the screen the reader
  // came from, so the back button and the browser's back are the same move —
  // and the same one the transition draws (screen-transition.ts). A list
  // reached any other way (a link into a conversation) has nothing behind it,
  // and dismiss then replaces the entry instead.
  const goToStellaList = useCallback(() => {
    router.dismiss({
      route: { kind: "stella", agentId: null },
      settings: null,
    });
  }, [router]);
  const goToStellaAgent = useCallback((id: string) => {
    pushUrl({ route: { kind: "stella", agentId: id }, settings: null });
  }, [pushUrl]);
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
    replaceUrl({ route: { kind: "stella", agentId: null }, settings: null });
  }, [
    stellaActive,
    stellaAgentId,
    stella.agentsLoading,
    stella.agents,
    replaceUrl,
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
  // The screen pane's switch and the edit dialog are opened from the title
  // bar, which this App draws (see StellaTitleBarHeader): their state is
  // here, above both the bar and the conversation it names.
  const [stellaScreenOpen, setStellaScreenOpen] = useState(false);
  const [editingStellaAgent, setEditingStellaAgent] = useState(false);
  const stellaHandedOver = stella.conversation?.handover !== null &&
    stella.conversation?.handover !== undefined;
  // The settings dialog's routine list: the active agent's routines
  // (code mode has no agent, so the list stays empty and says so).
  const routines = useRoutines(stellaActive ? stellaAgentId : null);
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
          onNew={() => goToTab(null)}
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
            onNew={() => goToTab(null)}
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
                {appMode.error === null
                  ? t("common.loading")
                  : t("common.serverUnreachable", { error: appMode.error })}
              </div>
            )
            : (
              <ModeGate
                status={machineStatus}
                mode={mode}
                error={appMode.error}
                choose={chooseMode}
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
        onNew={() => goToTab(null)}
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
                label={t("chat.stella.titleBarLabel")}
                onBack={stellaSingleScreen && stellaAgentId !== null
                  ? goToStellaList
                  : undefined}
                onEditAgent={() => setEditingStellaAgent(true)}
                onToggleScreen={machineStatus?.state === "running" &&
                    !stellaHandedOver && stellaAgentId !== null
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
                    onNew={() => goToTab(null)}
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
              onSelect={selectTab}
              onClose={closeTab}
              onCloseToRight={closeTabsToRight}
              onCloseToLeft={closeTabsToLeft}
              onCloseOthers={closeOtherTabs}
              onNew={() => goToTab(null)}
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
        <UpdateBanner update={update} stale={build.stale} />
        <ServerDownBanner health={serverHealth} />
        {loadError && (
          <div className="msg">
            <div className="msg-body error-text">
              <p>{t("common.serverUnreachable", { error: loadError })}</p>
            </div>
          </div>
        )}
        {refusedStella !== null && (
          <div className="msg">
            <div className="msg-body">
              <p className="error-text" role="alert">
                {t("chat.stella.refused", { reason: refusedStella })}
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => setRefusedStella(null)}
              >
                {t("common.close")}
              </button>
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
              input={draft.input}
              onInputChange={(input) => updateDraft(draftKey, { input })}
              images={draft.images}
              onImagesChange={(images) => updateDraft(draftKey, { images })}
              files={draft.files}
              onFilesChange={(files) => updateDraft(draftKey, { files })}
              onAgentChanged={stella.applyAgent}
              onSelectAgent={goToStellaAgent}
              onOpenSettings={openProviders}
              screenOpen={stellaScreenOpen}
              onScreenOpenChange={setStellaScreenOpen}
            />
          )
          : (
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
                    onOpenSettings={openProviders}
                  />
                );
              })}
              {draftPaneShown && (
                <DraftPane
                  active={activeTab === null}
                  draft={drafts.get(DRAFT_TAB) ?? EMPTY_DRAFT}
                  workspaces={workspaces}
                  workspacesLoaded={workspacesLoaded}
                  settingsVersion={settingsVersion}
                  updateDraft={updateDraft}
                  clearDraft={clearDraft}
                  startSession={startSession}
                  onWorkspaceChanged={handleWorkspaceChanged}
                  onDeleteWorkspace={deleteWorkspace}
                  onReopenSession={goToTab}
                  onOpenSettings={openProviders}
                />
              )}
              {activeTab !== null && !activePane && (
                // The address names a session this page has not drawn yet (a
                // bookmark, a reload, a link followed from elsewhere). Its
                // read is in flight, so the body says so rather than flashing
                // the new-session screen under the address of a session.
                <div className="chat-empty" role="status">
                  <div className="chat-empty-inner">
                    <p>{t("common.loading")}</p>
                  </div>
                </div>
              )}
            </>
          )}
      </div>
      <AppDialogs
        settings={settingsOpen && settingsRoute !== null
          ? {
            theme,
            themeError,
            onThemeChange: setTheme,
            language,
            languageError,
            onLanguageChange: setLanguage,
            update,
            notifyEnabled,
            onNotifyEnabledChange: handleNotifyEnabledChange,
            push,
            category: settingsRoute.category,
            onOpenCategory: openSettingsAt,
            onBackToList: backToSettingsList,
            routines,
            routineAgent: routineAgentName,
            onClose: closeSettings,
          }
          : null}
        recent={showRecent
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
          : null}
        close={pendingClose !== null
          ? {
            names: pendingClose.names,
            onCancel: tabClose.cancel,
            onStopAndClose: () => tabClose.resolve(false),
            onKeepRunning: () => tabClose.resolve(true),
          }
          : null}
        agentEdit={stellaActive && stellaAgent !== undefined &&
            editingStellaAgent
          ? {
            agent: stellaAgent,
            onChanged: (updated) => {
              stella.applyAgent(updated);
              setEditingStellaAgent(false);
            },
            onClose: () => setEditingStellaAgent(false),
          }
          : null}
        modeGate={showModeSelect
          ? {
            status: machineStatus,
            mode,
            error: appMode.error,
            choose: async (next) => {
              await chooseMode(next);
              setShowModeSelect(false);
            },
            onClose: closeModeSelect,
          }
          : null}
      />
    </div>
  );
}
