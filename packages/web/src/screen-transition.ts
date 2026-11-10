import { flushSync } from "preact/compat";
import type { UrlState } from "./route.ts";

/**
 * Which address moves are a screen transition, and how one is played.
 *
 * Two screens of this app are a hierarchy the reader walks into and back out
 * of: stella's agent list and one conversation (`/stella` and
 * `/stella/a/<id>`), and the settings dialog's category list and one category
 * (`…/settings` and `…/settings/<category>`). On a phone those are two
 * screens, not two columns, and nothing about the swap said which way the
 * reader had gone — the previous screen was gone before the next was drawn.
 *
 * Everything else is deliberately NOT a transition: a tab switch in code mode
 * is a lateral move between sessions, and a session is not deeper than the
 * draft screen it was opened from. Sliding those would claim a hierarchy that
 * is not there.
 *
 * The direction is decided here, from the two addresses and one fact about the
 * layout (see {@link ScreenLayout}). The shape, the duration and the
 * reduced-motion answer are the stylesheet's (styles/motion.css), which reads
 * `data-vt` off the root element.
 */

/** The way one screen replaced another: into a deeper screen, or back out. */
export type ScreenMove = "push" | "back";

/** What the layout adds to the addresses: the same two routes are a screen
 * swap on one window and two columns on another. */
export interface ScreenLayout {
  /** Whether stella's list and its conversation are two screens, one at a time
   * — the compact width and below (hooks/useMediaQuery.ts's COMPACT_QUERY). */
  singleScreen: boolean;
}

/** The root attribute the stylesheet reads while a transition plays. Its two
 * values are {@link ScreenMove}; it is removed when the transition ends, so no
 * rule can be selected by a transition that is not running. */
export const TRANSITION_ATTRIBUTE = "data-vt";

/**
 * Which way `next` moves from `previous`, or null when it is not a screen
 * transition (see the module comment).
 */
export function screenMove(
  previous: UrlState,
  next: UrlState,
  layout: ScreenLayout,
): ScreenMove | null {
  return stellaMove(previous, next, layout) ?? settingsMove(previous, next);
}

/** `/stella` ⇄ `/stella/a/<id>`, with no dialog over either: a dialog covers
 * the screen it was opened from, so opening or closing one is not a move
 * between the two screens underneath it. */
function stellaMove(
  previous: UrlState,
  next: UrlState,
  layout: ScreenLayout,
): ScreenMove | null {
  if (previous.route.kind !== "stella") return null;
  if (next.route.kind !== "stella") return null;
  if (previous.settings !== null || next.settings !== null) return null;
  // Two columns are not two screens: on a wide window the list slides to the
  // left margin and the conversation comes in from the right (stella.css), so
  // the layout animates itself. A page-wide snapshot there would capture both
  // lists — the centred one and the moved one — and cross-fade them over each
  // other.
  if (!layout.singleScreen) return null;
  return deepen(previous.route.agentId, next.route.agentId);
}

/** `…/settings` ⇄ `…/settings/<category>` of the SAME screen: a dialog opening
 * and closing is its own entrance and exit (Modal.tsx), not a step between two
 * of its pages. */
function settingsMove(previous: UrlState, next: UrlState): ScreenMove | null {
  if (previous.settings === null || next.settings === null) return null;
  if (!sameRoute(previous.route, next.route)) return null;
  return deepen(previous.settings.category, next.settings.category);
}

/** Whether two routes name the same screen, the settings dialog's own state
 * excluded (that is what the caller compares). */
function sameRoute(a: UrlState["route"], b: UrlState["route"]): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "modeSelect":
      return true;
    case "code":
      return a.tabKey === (b as typeof a).tabKey;
    case "stella":
      return a.agentId === (b as typeof a).agentId;
  }
}

/** Null (no page named) is the shallower end of both hierarchies, an id the
 * deeper one. Equal ends are not a move. */
function deepen(
  previous: string | null,
  next: string | null,
): ScreenMove | null {
  if (previous === next) return null;
  if (previous === null) return "push";
  if (next === null) return "back";
  // Two conversations, two categories: a lateral move, and this hierarchy has
  // no motion for one — the reader never came from the screen they are leaving,
  // both are reached from the list.
  return null;
}

/** Whether this browser can draw a view transition. `lib.dom` declares the
 * method unconditionally, so the check is made at runtime on the object the
 * page actually has: the API arrived in Chrome 111, Safari 18 and Firefox 133,
 * and an older build has to run the move without motion. */
function viewTransitions(): boolean {
  return typeof document.startViewTransition === "function";
}

/** The transition this page started last. A move made while one plays skips it
 * (the browser does that on its own) and its `finished` lands afterwards: only
 * the newest may clear the attribute, or a newer transition would lose its
 * direction halfway.
 */
let latest = 0;

/**
 * Play `move` around `update`, which writes the address and the state that
 * renders the next screen.
 *
 * The View Transition API snapshots the page around `update` and animates
 * between the two, so the reader sees the screen they left slide out instead
 * of disappearing in one frame. `flushSync` is what makes the second snapshot
 * the NEXT screen: Preact schedules a render on the microtask queue, and it
 * would not have committed by the time the API asks for the updated state.
 *
 * A browser without the API runs `update` at once and the screen changes
 * without motion. That is the same screen sequence — the API is a capability
 * to draw the move, not a behaviour this app needs from it.
 */
export function playScreenTransition(
  move: ScreenMove | null,
  update: () => void,
): void {
  if (move === null || !viewTransitions()) {
    update();
    return;
  }
  const root = document.documentElement;
  const mine = ++latest;
  // Set before the call, not inside the callback: the stylesheet's rule is
  // selected while the pseudo-element tree is built, which happens around the
  // callback rather than after it.
  root.setAttribute(TRANSITION_ATTRIBUTE, move);
  const transition = document.startViewTransition(() => {
    flushSync(update);
  });
  const settle = () => {
    if (latest !== mine) return;
    root.removeAttribute(TRANSITION_ATTRIBUTE);
  };
  // `finished` rejects when the update callback threw (the move itself
  // failed), which must clear the attribute just as a normal end does.
  void transition.finished.then(settle, settle);
}
