import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "preact/compat";

/**
 * Size a text field to its content, up to the ceiling its stylesheet allows.
 *
 * `field-sizing: content` is the declarative form of this, but Safari only
 * has it from 26.2 and the desktop app runs in WKWebView — there the field
 * would stay at its `min-height` for anyone on an older macOS. Writing the
 * height from `scrollHeight` works in every engine the app targets, and the
 * ceiling then stays where the rest of the field's metrics are: `max-height`
 * in the stylesheet. Nothing here knows how tall "too tall" is.
 *
 * Re-measured on `value` (typing, a draft restored, a menu insertion) and on
 * a change of WIDTH: the same text wraps into more lines when the pane or the
 * window narrows. The observer ignores height-only resizes, because those are
 * this hook's own writes and following them would loop.
 *
 * `visible` is the third moment: a field inside a pane another tab is showing
 * has no box, so a measurement there reads 0 and would write that height. The
 * fit is skipped while hidden and runs again when the pane is shown.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  visible = true,
): void {
  const fit = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    // `auto` first: a textarea's `scrollHeight` is never less than the box it
    // already occupies, so a field that lost lines would keep its old height
    // forever, and one sitting at its `min-height` would report that height
    // as its content.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref]);

  // Before paint: the field is drawn at the height its text needs, so a long
  // draft (a restored tab, a completed prompt) never shows one frame at the
  // wrong size. A writing animation is deliberately absent — the height
  // follows the caret, and a lag there reads as dropped input.
  useLayoutEffect(() => {
    if (visible) fit();
  }, [fit, value, visible]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
}
