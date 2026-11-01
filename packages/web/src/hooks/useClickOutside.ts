import { type RefObject, useEffect } from "preact/compat";

/** Close a popover/menu on outside click and Escape; optionally also on
 * scroll and window blur. Scroll closes for any scroll outside the
 * popover (capture phase — the fixed-position popover floats over a
 * page that scrolls independently), but a scroll that happens *inside*
 * the popover (e.g. a scrollable model list) is interaction with the
 * menu and must not close it. Shared by every dropdown so the listener
 * bookkeeping never varies.
 *
 * `within` names a second element that also counts as inside. A popover
 * portaled to the body (so it escapes an ancestor's `overflow: hidden`) is
 * no longer a DOM descendant of its trigger, and a click on it would read as
 * a click outside. */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
  options: {
    onScroll?: boolean;
    onBlur?: boolean;
    within?: RefObject<HTMLElement | null>;
  } = {},
): void {
  const { within } = options;
  useEffect(() => {
    if (!active) return;
    const contains = (target: Node) =>
      ref.current?.contains(target) === true ||
      within?.current?.contains(target) === true;
    const onPointerDown = (e: PointerEvent) => {
      if (!contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      // The scroll target is the element that actually scrolled; scrolls
      // from a container inside the popover are the user browsing the
      // menu, not the page behind it.
      if (!contains(e.target as Node)) onClose();
    };
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
  }, [active, onClose, ref, options.onScroll, options.onBlur, within]);
}
