import { type RefObject, useEffect } from "preact/compat";

/**
 * Publish an element's height as a CSS variable on a target element (the
 * `.app` root by default), so a stylesheet can position something relative to
 * it.
 *
 * Written on the root rather than on the element itself because the consumers
 * are `position: fixed` (the progress panels): a fixed box inherits only from
 * its own ancestors, and the root is the one ancestor every fixed panel in the
 * app has in common. This is the same contract `usePanelInset` uses for the
 * banner band.
 *
 * Measured rather than hardcoded: stella's header wraps (the machine state and
 * its buttons move to their own line on a narrow window), and a fixed offset
 * would either cover the controls or leave a gap as the window resizes. A
 * ResizeObserver keeps it current; it costs one observation per mount.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  variable = "--el-height",
  target: HTMLElement | null = document.documentElement,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null || target === null) return;
    const apply = () => {
      target.style.setProperty(
        variable,
        `${Math.round(element.getBoundingClientRect().height)}px`,
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => {
      observer.disconnect();
      // Leave the token's default (0px) rather than a measurement of a
      // layout that no longer exists.
      target.style.removeProperty(variable);
    };
  }, [ref, variable, target]);
}
