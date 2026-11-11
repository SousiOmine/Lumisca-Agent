import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "preact/compat";
import { useReducedMotion } from "../hooks/useMediaQuery.ts";

interface ModalProps {
  /** CSS width of the dialog. The value reaches the stylesheet as a variable
   * rather than as an inline `width` (`--modal-width`, whose token default is
   * the shared dialog width in tokens.css), so a narrow layout can still
   * override it — an inline width wins over every rule but `!important`. */
  width?: string;
  className?: string;
  /** What the dialog is, for assistive technology. Its visible title is a
   * child's `<h2>`, which this shell cannot reach to point `aria-labelledby`
   * at (the body is opaque to it); the value is the same string that heading
   * shows, so the two never disagree. */
  label: string;
  /**
   * Unmount the dialog. Called ONCE, after the exit has finished — so a
   * caller never has to know the exit exists: it passes the same handler it
   * would pass to a dialog that vanished instantly, and the removal is simply
   * 140ms later.
   */
  onClose: () => void;
  /** The dialog's body. A function receives `close`, which starts the exit;
   * a control INSIDE the dialog must use it instead of its own "close"
   * prop, or it would remove the sheet in one frame and skip the exit.
   *
   * `close(after)` runs `after` once the exit is over, just before
   * `onClose` — for the decisions that unmount the dialog from the caller's
   * side (a dialog that asks "stop the run or keep it going?" hands the
   * answer to its parent, which is what removes it). */
  children: ReactNode | ((close: (after?: () => void) => void) => ReactNode);
}

/** Anything the focus trap will let the user Tab to. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** How long the exit may take before the dialog removes itself anyway. The
 * transition is 140ms (modals.css); this is the safety net for one that never
 * runs (an ancestor with `display: none`, a background tab that throttles it).
 * Keep it above the transition, or a slow frame would cut the exit short. */
const EXIT_TIMEOUT_MS = 320;

/**
 * Shared backdrop + dialog shell: click on the backdrop closes, Escape
 * closes, and Tab cycles inside the dialog (the WCAG modal pattern).
 *
 * The sheet also plays its own exit. A dialog that unmounted in one frame
 * teleported out from under the pointer, which reads as a glitch rather than
 * as "you are done here"; here the backdrop dims away and the sheet settles
 * back down (modals.css) before `onClose` is called — once, when that is over.
 * Every way of closing goes through it: the backdrop, Escape, and the
 * dialog's own buttons (through the `close` a function child receives).
 */
export function Modal({
  width,
  className,
  label,
  onClose,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [closing, setClosing] = useState(false);
  // The exit ran to its end (or was cut short). `onClose` is delivered from
  // the effect below rather than from the event, so it cannot run during
  // another component's render — and exactly once: the caller unmounts this
  // dialog, but until it does, a re-render would re-run the effect.
  const [finished, setFinished] = useState(false);
  const closed = useRef(false);
  // Whether the exit is drawn. A reduced-motion reader gets none at all, not
  // even a one-frame `.closing` flash: with the transitions disabled the
  // class would hide the sheet instantly and then unmount it, which is the
  // teleport this component exists to avoid.
  const exiting = closing && !reduceMotion;
  // What a decision wants done once the sheet is gone, and the latest
  // `onClose` (the caller passes an inline arrow, so it changes every render;
  // reading it from a ref keeps the effect from re-running per render).
  const after = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback((then?: () => void) => {
    after.current = then ?? null;
    setClosing(true);
  }, []);

  useEffect(() => {
    if (!finished || closed.current) return;
    closed.current = true;
    const then = after.current;
    after.current = null;
    then?.();
    onCloseRef.current();
  }, [finished]);

  // Reduced motion: there is nothing to wait for, so the sheet goes on the
  // next commit instead of after a transition that will never start.
  useEffect(() => {
    if (!closing || !reduceMotion) return;
    setFinished(true);
  }, [closing, reduceMotion]);

  useEffect(() => {
    if (!exiting || finished) return;
    const timer = setTimeout(() => setFinished(true), EXIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [exiting, finished]);

  // Where the keyboard was before the dialog took it, restored on unmount:
  // closing returns the reader to the control that opened the sheet instead of
  // to the top of the page (which is where `document.body` is). The element
  // can be gone by then (a row the dialog deleted), so it is checked first.
  //
  // Captured in the same effect that moves the focus in, and only once: an
  // effect of its own that ran earlier would read the field a child already
  // focused with `autoFocus`, and closing would then return the reader to a
  // control inside the sheet that no longer exists. Reading it again on later
  // runs would do the same for the focus the dialog itself has moved.
  const opener = useRef<HTMLElement | null>(null);
  const captured = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (!captured.current) {
      captured.current = true;
      const before = document.activeElement;
      opener.current =
        before instanceof HTMLElement &&
        before !== document.body &&
        !dialog.contains(before)
          ? before
          : null;
    }
    // Move focus into the dialog: without this the keyboard stays on the
    // control behind the backdrop. A dialog whose child carries `autoFocus`
    // has already moved it; the check keeps this from stealing it back.
    if (!dialog.contains(document.activeElement)) focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      // The trap opens when the dialog leaves: Tab during the exit would walk
      // into a sheet that is already fading.
      if (closing) return;
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        // Nothing focusable inside: keep focus on the dialog itself so Tab
        // cannot walk into the page behind the backdrop.
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const outside = active === null || !dialog.contains(active);
      if (event.shiftKey) {
        if (outside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (outside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // Capture phase: Escape must reach the dialog even when a nested widget
    // (a popover inside the modal) handles keydown itself.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose, closing]);

  // Restored on unmount, not when the exit starts: the sheet is still on
  // screen while it fades, and moving the keyboard behind it first would put
  // the focus where the reader cannot see it.
  useEffect(
    () => () => {
      const target = opener.current;
      opener.current = null;
      if (target !== null && target.isConnected) target.focus();
    },
    [],
  );

  /** The exit ended on the sheet. The backdrop's transition bubbles through
   * here too, and so do the children's, so the target is checked. */
  const onExitEnd = (event: TransitionEvent) => {
    if (!exiting) return;
    if (event.target !== dialogRef.current) return;
    setFinished(true);
  };

  // The backdrop's click is wrapped: `requestClose` takes an optional
  // callback, and a bare handler would pass the click event as that callback.
  return (
    <div
      className={`modal-backdrop${exiting ? " closing" : ""}`}
      onClick={() => requestClose()}
    >
      <div
        ref={dialogRef}
        className={`${className ? `modal ${className}` : "modal"}${
          exiting ? " closing" : ""
        }`}
        style={width ? { "--modal-width": width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onTransitionEnd={onExitEnd}
      >
        {typeof children === "function" ? children(requestClose) : children}
      </div>
    </div>
  );
}
