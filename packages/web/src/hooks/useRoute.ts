import { useCallback, useEffect, useState } from "preact/compat";
import { parseUrl, urlOf, type UrlState } from "../route.ts";

/**
 * The address the app is showing, and how to move to another.
 *
 * The URL is the source of truth: this hook reads `location.pathname` once,
 * follows `popstate` (the browser's back and forward, macOS's swipe, the
 * keyboard's shortcut), and writes the address bar on every move. Nothing
 * else in the app keeps a copy of "which screen" — a second copy is the thing
 * that would drift from the address a reader copies or reloads.
 *
 * `push` adds a history entry, `replace` overwrites the current one. Which
 * one a move gets is a product decision made at the call site: opening a
 * session or the settings is a place the reader wants to come back to (push),
 * while resolving `/` into a mode's top, or falling back because a session is
 * gone, is not (replace — there is no place to return to).
 */
export interface RouteControls {
  state: UrlState;
  /** Move to `next`, adding a history entry. */
  push: (next: UrlState) => void;
  /** Move to `next`, overwriting this entry. */
  replace: (next: UrlState) => void;
  /** Return to the entry `next` was pushed from, or replace when there is
   * none (see {@link canGoBack}). */
  dismiss: (next: UrlState) => void;
}

/**
 * Marker the entries this app pushes carry in `history.state`.
 *
 * `history.back()` is only safe when the entry behind is one the app made:
 * a page opened straight from a link sits on an entry of the app's own, and
 * going back from it would leave the app entirely. What is checked is the
 * CURRENT entry: an entry the app pushed always has an app screen behind it
 * (a push only happens from within the app), so its marker is the whole
 * answer.
 */
const APP_ENTRY = "lumisca";

function entryState(): unknown {
  const current = globalThis.history.state as
    | Record<string, unknown>
    | null;
  return current?.[APP_ENTRY];
}

/** Whether the current entry was pushed by this app (see {@link APP_ENTRY}). */
export function canGoBack(): boolean {
  return entryState() === true;
}

export function useRoute(): RouteControls {
  const [state, setState] = useState<UrlState>(() =>
    parseUrl(location.pathname)
  );

  useEffect(() => {
    const onPopState = () => setState(parseUrl(location.pathname));
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, []);

  // A move writes the address bar first and the state second, so a render
  // caused by `setState` already finds the two agreeing. `pushState` does not
  // fire `popstate` (the browser only does that for entries it made itself),
  // which is why the state is set here rather than by the listener.
  //
  // The query is kept: only the path is the app's, and a page URL's `?token=`
  // belongs to the server's token guard. `location.search` still holds it at
  // this point — client.tsx strips the token from the address bar before the
  // app mounts, so by the time a move happens there is usually nothing left.
  //
  // Only a PUSH marks the entry. A replace keeps whatever state the entry
  // already had: it is the entry the page was loaded on (nothing behind it),
  // and marking it would claim there is a screen to go back to.
  const move = useCallback((next: UrlState, replace: boolean) => {
    const url = urlOf(next);
    if (location.pathname !== url) {
      const target = `${url}${location.search}`;
      if (replace) {
        globalThis.history.replaceState(globalThis.history.state, "", target);
      } else {
        globalThis.history.pushState({ [APP_ENTRY]: true }, "", target);
      }
    }
    setState(next);
  }, []);

  const push = useCallback((next: UrlState) => move(next, false), [move]);
  const replace = useCallback((next: UrlState) => move(next, true), [move]);

  const dismiss = useCallback((next: UrlState) => {
    if (canGoBack()) {
      globalThis.history.back();
      // The `popstate` listener restores the state from the restored path;
      // nothing is set here, or the two would race.
      return;
    }
    move(next, true);
  }, [move]);

  return { state, push, replace, dismiss };
}
