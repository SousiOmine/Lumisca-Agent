import type { AppMode } from "@lumisca/core/shared";
import { errorMessage } from "@lumisca/core/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { useCodeModeEnabled } from "../codeMode.ts";
import type { SettingsCategory } from "../components/SettingsModal.tsx";
import {
  type AppRoute,
  availableRoute,
  type SettingsRoute,
  type UrlState,
} from "../route.ts";
import type { StellaStatus } from "../types.ts";
import { rememberMode, startMode, useAppMode } from "./useAppMode.ts";
import { useRoute } from "./useRoute.ts";

/**
 * Where the app is: the address, the mode it shows, and the moves every
 * screen makes.
 *
 * The rule this hook keeps is the app's first one — the URL is the single
 * answer to "where am I" (route.ts), so a reload, a bookmark and the back
 * button all agree. That leaves three questions that are not the address's
 * own: which mode a bare `/` resolves to, which addresses this installation
 * cannot show (code mode switched off, a finished setup), and where the
 * settings dialog sits on the screen underneath it. They belong together
 * because the answers constrain each other: the redirect that replaces one
 * address keeps the dialog open, and the mode is only remembered once the
 * server has accepted it.
 *
 * Extracted from App.tsx, which was also the composition point of both
 * modes' bodies, the dialogs and the window chrome: a change to a resolution
 * rule meant reading JSX about tabs and composers.
 */
export interface AppNavigation {
  /** The route the app DRAWS. While code mode is switched off this is
   * stella's top even for an address that names code mode, so the session
   * such an address names is never opened on the way to the redirect. */
  route: AppRoute;
  /** The mode this page shows. */
  mode: AppMode;
  /** The settings dialog's position in the address, or null while closed. */
  settings: SettingsRoute | null;
  /** What this server can do for stella mode, and how its machine is doing
   * (null while the first read is in flight). */
  machineStatus: StellaStatus | null;
  /** Why Lumisca did not open, or null. */
  refusedStella: string | null;
  /** Take the refusal off the screen. */
  dismissRefusedStella: () => void;
  /** Switch modes in one press from the app menu. */
  switchMode: (next: AppMode) => Promise<void>;
  /** Move to another settings category (a navigation: the address names the
   * page). `null` names no category, and the dialog picks its first screen
   * for the layout it gets. */
  openSettingsAt: (category: SettingsCategory | null) => void;
  openSettings: () => void;
  /** Settings → プロバイダー, the page a conversation without a model opens. */
  openProviders: () => void;
  /** Settings → 接続先サーバー, the page the connection picker's "manage"
   * entry opens. */
  openServers: () => void;
  closeSettings: () => void;
  backToSettingsList: () => void;
  /** Overwrite this entry (a resolution: there is no place to return to).
   * Callers in the App use it for a screen that is gone — a closed tab, a
   * conversation that no longer exists. */
  replace: (next: UrlState) => void;
  /** Show one code-mode tab (`null` = the new-session screen). */
  goToTab: (key: string | null) => void;
  /** Back to the agent list, by walking the history back. */
  goToStellaList: () => void;
  /** Open one agent's conversation (a navigation: the address names it). */
  goToStellaAgent: (id: string) => void;
}

/** The address of a mode's top screen. */
export function modeTop(mode: AppMode): UrlState {
  return {
    route:
      mode === "code"
        ? { kind: "code", tabKey: null }
        : { kind: "stella", agentId: null },
    settings: null,
  };
}

/** The address of one code-mode tab (`null` = the new-session screen). The
 * settings dialog is never open on a tab move: it covers the screen it was
 * opened from, and moving to another one closes it. */
export function codeUrl(tabKey: string | null): UrlState {
  return { route: { kind: "code", tabKey }, settings: null };
}

export function useAppNavigation({
  setupPending,
}: {
  /** Whether the first-run setup is unfinished: while it is, `/` is the
   * wizard rather than a mode's top (hooks/useSetup). */
  setupPending: boolean;
}): AppNavigation {
  // The address the app is showing. Every screen the app draws is read from
  // it, and every move writes it back.
  const router = useRoute();
  const url = router.state;
  const { push: pushUrl, replace: replaceUrl } = router;
  // Code mode is an experimental switch (settings → 実験的機能). While it is
  // off, a `/code` address is not a screen: the route the app DRAWS is
  // stella's top, so the session the address names is never opened on the
  // way to the redirect below.
  const codeMode = useCodeModeEnabled();
  const route = availableRoute(url.route, codeMode);

  // Which mode this page shows. The address names it, except at `/`: that is
  // the address the desktop shell and an installed PWA open, and it resolves
  // to the mode this client showed last, or to the main mode (Lumisca) when
  // it has never chosen. No address shows a chooser: the mode is switched
  // from the app menu in one press.
  //
  // Memoized on the route kind: the store is a `localStorage` read, and the
  // App re-renders on every streamed event of a conversation.
  const resolved = useMemo(() => startMode(codeMode), [route.kind, codeMode]);
  // The setup screen shows no mode; it resolves `/` the same way the start
  // address does, so the hooks below keep one shape (and the wizard's own
  // "start" lands on the mode the reader would have opened).
  const mode: AppMode =
    route.kind === "start" || route.kind === "setup" ? resolved : route.kind;
  // The resolution is a REPLACE: `/` is not a place to come back to, and a
  // back from a mode's top must leave the app rather than bounce off the
  // address it never meant to show. While the setup is unfinished, `/` is
  // the wizard instead (the only address that is redirected there: a
  // bookmark of a session or a mode still opens, see AGENTS.md).
  useEffect(() => {
    if (url.route.kind !== "start") return;
    replaceUrl(
      setupPending
        ? { route: { kind: "setup" }, settings: null }
        : modeTop(mode),
    );
  }, [url.route.kind, mode, replaceUrl, setupPending]);
  // A finished setup has nowhere to stay: `/setup` (a bookmark, the address a
  // reload kept) belongs to `/`, which resolves the mode the reader would
  // have started in.
  useEffect(() => {
    if (url.route.kind !== "setup" || setupPending) return;
    replaceUrl(modeTop(mode));
  }, [url.route.kind, mode, replaceUrl, setupPending]);
  // Code mode is off: an address that names it is replaced by stella's top.
  // The settings dialog stays open — the reader may be looking at the very
  // switch that turned it off — so only the screen underneath changes.
  useEffect(() => {
    if (url.route.kind !== "code" || codeMode) return;
    replaceUrl({
      route: { kind: "stella", agentId: null },
      settings: url.settings,
    });
  }, [codeMode, url.route.kind, url.settings, replaceUrl]);

  // What this server can do for stella mode, and how its machine is doing.
  const appMode = useAppMode(mode);
  const machineStatus = appMode.status;
  /** Why Lumisca did not open: the server refused it, either for an address
   * that names it or for the app menu's switch, which has no chooser left to
   * keep the reason in. */
  const [refusedStella, setRefusedStella] = useState<string | null>(null);
  const dismissRefusedStella = useCallback(() => setRefusedStella(null), []);
  // A mode whose whole premise is a virtual machine has no honest degraded
  // form: an address that names stella on a server that cannot run it lands
  // on code mode's top, with the reason on screen. A switch made from the
  // menu never gets there — `choose` refuses before the address changes —
  // so the reason it leaves on screen is cleared here once the machine can
  // run. With code mode switched off there is nowhere to fall back to: the
  // reason stays on stella's screen, where the settings dialog is still one
  // press away.
  useEffect(() => {
    if (machineStatus === null) return;
    if (machineStatus.availability.available) {
      // The machine came up (or another server answered): the sentence
      // describes a state that no longer holds.
      setRefusedStella(null);
      return;
    }
    if (mode !== "stella") return;
    setRefusedStella(machineStatus.availability.reason);
    if (codeMode) {
      // The settings dialog stays open if it was: the reader may be on the
      // page that offers the switch this fallback depends on.
      replaceUrl({
        route: { kind: "code", tabKey: null },
        settings: url.settings,
      });
    }
  }, [codeMode, mode, machineStatus, replaceUrl, url.settings]);
  // Showing a mode is what this client remembers for the next bare `/` —
  // whether it was chosen here or arrived at through an address. The mode is
  // remembered only once the server has accepted it: a refused stella would
  // otherwise be the answer every launch, and the reader would meet the same
  // refusal instead of starting where they can work.
  useEffect(() => {
    if (mode === "stella" && machineStatus === null) return;
    if (mode === "stella" && !machineStatus?.availability.available) return;
    rememberMode(mode);
  }, [mode, machineStatus]);

  const goToTab = useCallback(
    (key: string | null) => pushUrl(codeUrl(key)),
    [pushUrl],
  );
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
  const goToStellaAgent = useCallback(
    (id: string) => {
      pushUrl({ route: { kind: "stella", agentId: id }, settings: null });
    },
    [pushUrl],
  );

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
  const openSettingsAt = useCallback(
    (category: SettingsCategory | null) => {
      pushUrl({ ...urlRef.current, settings: { category } });
    },
    [pushUrl],
  );
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
    () => openSettingsAt("connections"),
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

  /** Switch modes in one press from the app menu: the server's verdict first
   * (stella may be refused), then the address.
   *
   * It REPLACES rather than pushes: the menu is not a place to come back to,
   * and `/` resolves to the very mode just chosen, so a back would bounce
   * through the old address instead of leaving it.
   *
   * A refusal leaves the reader where they are and puts the reason on the
   * screen they are on: the menu names the destination, so there is no
   * chooser left open to hold that sentence.
   *
   * Depends on `choose` alone rather than the whole hook result, which is a
   * fresh object each render: the identity of this callback has to hold or
   * the memoized tab bar would re-render on every streamed event. */
  const switchMode = useCallback(
    async (next: AppMode) => {
      if (next === mode) return;
      try {
        await appMode.choose(next);
        setRefusedStella(null);
        replaceUrl(modeTop(next));
      } catch (failure) {
        setRefusedStella(errorMessage(failure));
      }
    },
    [appMode.choose, mode, replaceUrl],
  );

  return {
    route,
    mode,
    settings: url.settings,
    machineStatus,
    refusedStella,
    dismissRefusedStella,
    switchMode,
    openSettingsAt,
    openSettings,
    openProviders,
    openServers,
    closeSettings,
    backToSettingsList,
    replace: replaceUrl,
    goToTab,
    goToStellaList,
    goToStellaAgent,
  };
}
