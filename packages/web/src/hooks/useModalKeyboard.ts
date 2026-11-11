/**
 * What an over-app surface owes the keyboard and the page behind it.
 *
 * A dialog and a picture viewer both need the same four things, and both had
 * written them out separately (Modal.tsx and Lightbox.tsx): the surface takes
 * the focus, Escape closes it, Tab cannot wander into the page behind it, and
 * the page behind stops scrolling. Two copies meant a fix (returning the
 * focus to the opener, say) landed in one of them.
 *
 * This hook is the shared part. What it deliberately does NOT own is the
 * mount/unmount timing: a dialog plays an exit before it removes itself (see
 * Modal) and a viewer does not, so the caller keeps that decision.
 */
import { type RefObject, useEffect } from "preact/compat";

export interface ModalKeyboardOptions {
  /** The element that should hold the focus while the surface is open. */
  surface: RefObject<HTMLElement | null>;
  /** Close the surface (Escape, or the caller's own control). */
  onClose: () => void;
  /** Lock the page behind it so the wheel cannot move what the reader just
   * left. Default true. */
  lockScroll?: boolean;
}

/**
 * Take the focus, bind Escape and Tab, and stop the page scrolling — and undo
 * all three when the surface closes or the caller unmounts.
 *
 * The focus goes back to whatever had it before, when that element is still
 * in the document: a keyboard user returns to the control they opened the
 * surface from, not to the top of the page.
 */
export function useModalKeyboard({
  surface,
  onClose,
  lockScroll = true,
}: ModalKeyboardOptions): void {
  useEffect(() => {
    const opener = document.activeElement;
    surface.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      // Tab has nowhere to go inside a surface that holds no controls (a
      // picture), so it is kept on the surface rather than walked into the
      // page behind it. A dialog owns a real focus trap (see Modal), which
      // runs first and consumes the key before this sees it.
      if (
        event.key === "Tab" &&
        (surface.current?.childElementCount ?? 0) === 0
      ) {
        event.preventDefault();
        surface.current?.focus();
      }
    };
    globalThis.addEventListener("keydown", onKey);

    const previous = lockScroll ? document.body.style.overflow : undefined;
    if (lockScroll) document.body.style.overflow = "hidden";

    return () => {
      globalThis.removeEventListener("keydown", onKey);
      if (previous !== undefined) document.body.style.overflow = previous;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [surface, onClose, lockScroll]);
}
