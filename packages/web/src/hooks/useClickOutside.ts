import { type RefObject, useEffect } from "react";

/** Close a popover/menu on outside click and Escape; optionally also on
 * scroll (capture phase — closes for any scroll, including inside the
 * menu itself) and window blur. Shared by every dropdown so the
 * listener bookkeeping never varies. */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
  options: { onScroll?: boolean; onBlur?: boolean } = {},
): void {
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    if (options.onScroll) document.addEventListener("scroll", onScroll, true);
    if (options.onBlur) globalThis.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      if (options.onScroll) {
        document.removeEventListener("scroll", onScroll, true);
      }
      if (options.onBlur) globalThis.removeEventListener("blur", onBlur);
    };
  }, [active, onClose, ref, options.onScroll, options.onBlur]);
}
