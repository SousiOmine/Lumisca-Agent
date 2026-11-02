import { useCallback, useRef, useState } from "preact/compat";

/**
 * Keep an element mounted while it animates out.
 *
 * An element that unmounts immediately cannot animate its exit: the DOM node
 * is gone before the first frame. React's answer is a presence component
 * (AnimatePresence); this is the same idea at the size the app needs, for the
 * surfaces whose disappearance would otherwise teleport — a dialog closing
 * back to its trigger, the machine's screen folding away from the
 * conversation.
 *
 * The caller decides WHAT the exit looks like (a data attribute it styles, or
 * an animation it starts); this hook only owns the lifetime:
 *
 *   1. `open` turns true  → `mounted` is true and the element renders.
 *   2. `open` turns false → `mounted` STAYS true and `exiting` turns true, so
 *      the caller can play its exit.
 *   3. The caller calls `done()` when that exit finished (the animation's
 *      promise, `transitionend`, or a safety timer). Only then is the element
 *      removed.
 *
 * A reduced-motion reader never waits: the exit is an instant unmount
 * (styles/reduced-motion.css explains what "gentler" means there), so the
 * hook takes `instant` and skips step 2.
 *
 * `onExited` runs after the element is gone — where a caller releases what the
 * surface was holding (the VNC client, the focus).
 */
export interface Presence {
  /** Whether the element should be in the DOM right now. */
  mounted: boolean;
  /** Whether the element is on its way out (the caller's exit style). */
  exiting: boolean;
  /** The exit finished (or never started): remove the element. Idempotent, so
   * a `transitionend` plus a safety timer is safe. */
  done: () => void;
}

export interface PresenceOptions {
  /** Unmount without an exit phase (a reduced-motion reader, or a surface
   * with no exit worth showing). */
  instant?: boolean;
  /** Runs once the element has been removed. */
  onExited?: () => void;
}

/**
 * The lifetime of a conditionally rendered surface (see {@link Presence}).
 *
 * The caller renders `mounted ? <Thing data-exit={exiting} /> : null` and
 * plays its exit when `exiting` is set. Nothing here measures or times the
 * exit: the caller knows what it drew, and a hook that guessed a duration
 * would either cut the animation short or hold the element past it.
 */
export function usePresence(
  open: boolean,
  { instant = false, onExited }: PresenceOptions = {},
): Presence {
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  // `done` has already ended this exit (see below).
  const doneRef = useRef(false);
  // The last state the caller asked for, readable inside `done` without
  // putting it in the callback's identity (the caller passes `done` to an
  // event handler or an animation callback, and a new identity per render
  // would re-subscribe per frame).
  const openRef = useRef(open);
  openRef.current = open;

  // The open/close edge is applied in the render that sees it rather than
  // from an effect: an effect lands after the first paint, which is one frame
  // of the element sitting at its final place before its exit starts.
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      // Reopening during an exit cancels it: the element never left, so it
      // must not fade back in from the exit's own end state.
      doneRef.current = false;
      setMounted(true);
      setExiting(false);
    } else if (instant) {
      setMounted(false);
      setExiting(false);
    } else {
      doneRef.current = false;
      setExiting(true);
    }
  }

  const done = useCallback(() => {
    // Reopened while leaving: the element is wanted, so only the exit style
    // goes away.
    if (openRef.current) {
      setExiting(false);
      return;
    }
    // Idempotent: a caller usually has a `transitionend` AND a safety timer,
    // and `onExited` may release something (a VNC client) that must not be
    // released twice.
    if (doneRef.current) return;
    doneRef.current = true;
    setExiting(false);
    setMounted(false);
    onExitedRef.current?.();
  }, []);

  return { mounted, exiting, done };
}
