import {
  isSettingsCategory,
  type SettingsCategory,
} from "./components/settings/categories.ts";
import { splitTabKey, tabKey } from "./tabs.ts";

/**
 * The app's screens as URLs.
 *
 * Every screen the app can show has an address, so a reload, a bookmark, a
 * shared link and the browser's back button all reach the same place:
 *
 *   /                          the start address (this client's mode's top)
 *   /setup                     the first-run setup, until it is finished
 *   /code                      code mode's new-session screen
 *   /code/s/<sessionId>        one session of this server
 *   /code/p/<peerId>/s/<id>    one session of a federated peer
 *   /stella                    stella mode's agent list
 *   /stella/a/<agentId>        one conversation
 *   …/settings                 the settings dialog, first page
 *   …/settings/<category>      the settings dialog, one category
 *
 * Settings hang UNDER a screen's path rather than living at `/settings`:
 * the dialog is drawn OVER that screen, and closing it returns there (the
 * session a code-mode tab had open, the agent whose conversation was
 * showing). The categories are the installation's and the same in both modes
 * (categories.ts); the path names the screen underneath, not a set of pages.
 *
 * A code-mode URL carries the tab key, not a (peer, session) pair: the tab
 * strip, the event stream and the per-session API are all keyed by it (see
 * tabs.ts), and a second spelling of "which session" is the one thing that
 * would drift. Splitting happens here, on keys this app built.
 *
 * Everything in this module is pure (no `location`, no `history`): what a
 * path means is a rule to be tested, not a side effect. hooks/useRoute.ts is
 * the only place that touches the browser's history.
 */

/** The screen a URL names. `null` inside a mode is that mode's top.
 *
 * `start` is `/` itself and every path this app does not name: the App
 * resolves it to this client's mode's top (see hooks/useAppMode.ts).
 *
 * `setup` is the first-run wizard. It is a place of its own rather than a
 * flag on the start address: the address has to say what is on screen, and
 * the wizard is where `/` sends the reader while the installation's setup is
 * unfinished (see App.tsx). */
export type AppRoute =
  | { kind: "start" }
  | { kind: "setup" }
  | { kind: "code"; tabKey: string | null }
  | { kind: "stella"; agentId: string | null };

/**
 * The settings dialog's position.
 *
 * A dialog is not a route of its own because it is drawn OVER the screen it
 * was opened from, and closing it must return to exactly that screen
 * (including the session a code-mode tab had open). Keeping it beside the
 * route means the pair IS the address, and closing the dialog is a `back`.
 *
 * `{ category: null }` is "open, no page named" — the app menu's way in. The
 * dialog then picks its first screen for the layout it has: 一般 beside the
 * navigation, the category list on a narrow window, where the page would
 * otherwise hide the very list that leads to another category.
 */
export type SettingsRoute = { category: SettingsCategory | null };

/** One address: the screen, and the settings dialog when it is open. */
export interface UrlState {
  route: AppRoute;
  /** The open dialog, or null. Never set on the start address: there is no
   * mode yet, so there is no category set to name. */
  settings: SettingsRoute | null;
}

/** The path of one address. */
export function urlOf(state: UrlState): string {
  const base = routePath(state.route);
  if (state.settings === null) return base;
  const prefix = base === "/" ? "" : base;
  return state.settings.category === null
    ? `${prefix}/settings`
    : `${prefix}/settings/${state.settings.category}`;
}

function routePath(route: AppRoute): string {
  switch (route.kind) {
    case "start":
      return "/";
    case "setup":
      return "/setup";
    case "code": {
      if (route.tabKey === null) return "/code";
      const { peerId, sessionId } = splitTabKey(route.tabKey);
      const session = `/s/${encodeURIComponent(sessionId)}`;
      return peerId === ""
        ? `/code${session}`
        : `/code/p/${encodeURIComponent(peerId)}${session}`;
    }
    case "stella":
      return route.agentId === null
        ? "/stella"
        : `/stella/a/${encodeURIComponent(route.agentId)}`;
  }
}

/**
 * What a path means.
 *
 * A path this app does not name is read as the start address, which the App
 * resolves to this client's mode's top: a typo, a stale bookmark of a route
 * this version no longer has, or a category that was removed lands on a
 * screen the reader can use. The app has no "not found" page to send them to,
 * and a rendered error would be one they cannot leave.
 *
 * Under `/code` and `/stella`, a malformed session or agent path is that
 * mode's top rather than the start address: the reader was already in the
 * mode, and a missing id does not unmake that.
 */
export function parseUrl(pathname: string): UrlState {
  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeSegment);

  const [first, second, third, fourth, fifth] = segments;
  let route: AppRoute = { kind: "start" };
  let consumed = 0;

  if (first === "code") {
    route = { kind: "code", tabKey: null };
    consumed = 1;
    if (second === "s" && isId(third)) {
      route = { kind: "code", tabKey: tabKey("", third) };
      consumed = 3;
    } else if (second === "p" && isId(third) && fourth === "s" && isId(fifth)) {
      route = { kind: "code", tabKey: tabKey(third, fifth) };
      consumed = 5;
    }
  } else if (first === "stella") {
    route = { kind: "stella", agentId: null };
    consumed = 1;
    if (second === "a" && isId(third)) {
      route = { kind: "stella", agentId: third };
      consumed = 3;
    }
  } else if (first === "setup") {
    route = { kind: "setup" };
    consumed = 1;
  }

  return { route, settings: settingsOf(route, segments.slice(consumed)) };
}

/** The settings part of a path, given what the route did not consume. */
function settingsOf(route: AppRoute, trailing: string[]): SettingsRoute | null {
  // The start address names no mode, so settings have no screen to sit on:
  // an address that put them there is the start address. The setup screen
  // does hold them: the title bar's menu opens settings during the wizard,
  // and closing the dialog returns to the wizard.
  if (route.kind === "start") return null;
  if (trailing[0] !== "settings") return null;
  if (trailing.length === 1) return { category: null };
  if (trailing.length > 2) return null;
  const category = trailing[1];
  // A category the dialog does not have is "no page named" rather than an
  // error: a category is a position in a list, not a document that can be
  // missing, and the reader still gets the dialog they asked for.
  return {
    category:
      category !== undefined && isSettingsCategory(category) ? category : null,
  };
}

/** One path segment as text. `decodeURIComponent` throws on a malformed
 * escape (`%zz`), and a URL a reader typed by hand is not allowed to take the
 * app down: such a segment keeps its literal spelling, which then misses
 * whatever it was meant to name. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether a segment names an id. Ids are generated by the server (UUIDs) or
 * taken from the connection registry (`ConnectionEntry.id`, also a UUID), so
 * an empty or dot-like segment is a path that meant a top screen. */
function isId(segment: string | undefined): segment is string {
  return (
    segment !== undefined &&
    segment !== "" &&
    segment !== "." &&
    segment !== ".."
  );
}
