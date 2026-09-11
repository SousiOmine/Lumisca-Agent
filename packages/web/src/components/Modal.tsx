import { useEffect, useRef } from "preact/compat";
import type { ReactNode } from "preact/compat";

interface ModalProps {
  width?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
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

/** Shared backdrop + dialog shell: click on the backdrop closes, Escape
 * closes, and Tab cycles inside the dialog (the WCAG modal pattern). */
export function Modal({ width, className, onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    // Move focus into the dialog: without this the keyboard stays on the
    // control behind the backdrop.
    if (!dialog.contains(document.activeElement)) focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
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
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
