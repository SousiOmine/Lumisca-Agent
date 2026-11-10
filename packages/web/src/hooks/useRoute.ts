import { useCallback, useEffect, useRef, useState } from "preact/compat";
import { parseUrl, urlOf, type UrlState } from "../route.ts";
import {
  dialogDepth,
  dismissSteps,
  isAppEntry,
  pushedState,
  replacedState,
} from "../history-entry.ts";
import {
  playScreenTransition,
  type ScreenLayout,
  screenMove,
} from "../screen-transition.ts";
import { useCompactViewport } from "./useMediaQuery.ts";

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
 *
 * Every move also passes through `playScreenTransition`: the addresses alone
 * decide whether it animates (screen-transition.ts), and a move that is not
 * one of the two hierarchies simply changes screen at once.
 */
export interface RouteControls {
  state: UrlState;
  /** Move to `next`, adding a history entry. */
  push: (next: UrlState) => void;
  /** Move to `next`, overwriting this entry. */
  replace: (next: UrlState) => void;
  /** Return to the screen `next` names by walking the history back — the
   * entry it was pushed from, which for the settings dialog is below every
   * page opened inside it — or replace when there is none (see
   * {@link canGoBack}). */
  dismiss: (next: UrlState) => void;
}

/**
 * Whether the current entry was pushed by this app (see history-entry.ts).
 *
 * `history.back()` is only safe when the entry behind is one the app made:
 * a page opened straight from a link sits on an entry of the app's own, and
 * going back from it would leave the app entirely. What is checked is the
 * CURRENT entry: an entry the app pushed always has an app screen behind it
 * (a push only happens from within the app), so its marker is the whole
 * answer.
 */
export function canGoBack(): boolean {
  return isAppEntry(globalThis.history.state);
}

export function useRoute(): RouteControls {
  const [state, setState] = useState<UrlState>(() =>
    parseUrl(location.pathname)
  );
  // The screen on display, readable from a `popstate` handler without putting
  // the address in the listener's identity (a listener rebuilt per navigation
  // would resubscribe on every move). The state is still the source of truth:
  // this is the copy used to say which way a move went.
  const shown = useRef(state);
  shown.current = state;
  // Whether stella's list and conversation are two screens rather than two
  // columns, which decides whether a move between them is a page transition at
  // all (screen-transition.ts). Held in a ref for the same reason as `shown`:
  // the back/forward listener is subscribed once and must read what the window
  // is now.
  const singleScreen = useCompactViewport();
  const layout = useRef<ScreenLayout>({ singleScreen });
  layout.current = { singleScreen };

  useEffect(() => {
    const onPopState = () => {
      const next = parseUrl(location.pathname);
      const way = screenMove(shown.current, next, layout.current);
      playScreenTransition(way, () => {
        setState(next);
      });
    };
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
  // Only a PUSH creates a place to come back to, so only a push marks the
  // entry. A replace keeps the marker the entry already had: it is the same
  // entry, the page was loaded on or the app pushed earlier. What both write
  // is the dialog's depth (history-entry.ts): closing the settings dialog
  // must walk back over every page it opened, and the address alone cannot
  // say how many that is.
  const move = useCallback((next: UrlState, replace: boolean) => {
    const way = screenMove(shown.current, next, layout.current);
    playScreenTransition(way, () => {
      const url = urlOf(next);
      if (location.pathname !== url) {
        const target = `${url}${location.search}`;
        if (replace) {
          globalThis.history.replaceState(
            replacedState(globalThis.history.state, next),
            "",
            target,
          );
        } else {
          globalThis.history.pushState(
            pushedState(globalThis.history.state, next),
            "",
            target,
          );
        }
      }
      // `flushSync` commits this before the transition's second snapshot: the
      // URL and the screen it names change together, or the snapshot would
      // hold one without the other.
      setState(next);
    });
  }, []);

  const push = useCallback((next: UrlState) => move(next, false), [move]);
  const replace = useCallback((next: UrlState) => move(next, true), [move]);

  const dismiss = useCallback((next: UrlState) => {
    if (canGoBack()) {
      // `popstate` restores the state from the restored path — and decides
      // the direction of the move, which is why nothing is set here.
      //
      // The settings dialog is more than one entry deep once its pages were
      // picked; closing it reaches the screen it covered in one move, so the
      // sheet's exit and the screen behind agree (history-entry.ts).
      const steps = dismissSteps(dialogDepth(globalThis.history.state), next);
      if (steps === 1) globalThis.history.back();
      else globalThis.history.go(-steps);
      return;
    }
    move(next, true);
  }, [move]);

  return { state, push, replace, dismiss };
}
