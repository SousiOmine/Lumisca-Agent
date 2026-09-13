import { useCallback, useLayoutEffect, useState } from "preact/compat";

/** Height of the vertical band the app stacks above the chat (the update
 * banner today), as a CSS variable on the `.app` root. The fixed
 * top-right progress panels add it to their own offset so they step
 * around banners instead of covering them.
 *
 * The variable is set with the measured height; the token's default
 * (`0px`, see styles/tokens.css) is what a page without banners uses.
 * A missing default would invalidate the whole `calc()` and drop the
 * panels to the viewport top. */
export const BANNER_INSET_VAR = "--app-banner-height";

/**
 * A banner hands its root element to the app through this callback: the
 * element while it is on screen, `null` while it renders nothing (see
 * {@link usePanelInset} for what the measurement is used by). It is a
 * plain prop, not a `ref`: Preact resolves a `ref` on a function
 * component to the component instance and never passes it down, so the
 * banner has to place the callback on its own DOM node.
 *
 * The callback must be referentially stable (a `useCallback`), otherwise
 * the app re-measures on every render.
 */
export type BannerMount = (element: HTMLElement | null) => void;

/** Sum of the banner heights: they stack in the app body's flow, one after
 * the other. `offsetHeight` is used (not the fractional
 * `getBoundingClientRect().height`) because the result goes straight into
 * a `calc()`; a whole number of CSS pixels keeps the panels on the same
 * pixel grid as the banners they follow. */
function readBannerInset(banners: readonly HTMLElement[]): number {
  let height = 0;
  for (const banner of banners) height += banner.offsetHeight;
  return height;
}

/** Apply the measured banner height to the `.app` root, the styling hook
 * of {@link BANNER_INSET_VAR}. Writing the property directly (instead of
 * holding the value in state) keeps a pure layout change out of the
 * render path: nothing in the tree depends on the number, only the
 * stylesheet does. */
function applyBannerInset(
  app: HTMLElement | null,
  banners: readonly HTMLElement[],
): void {
  if (!app) return;
  const height = readBannerInset(banners);
  if (height > 0) {
    app.style.setProperty(BANNER_INSET_VAR, `${height}px`);
  } else {
    // No banners: fall back to the token's default rather than pinning the
    // panels to a value measured from a layout that no longer exists.
    app.style.removeProperty(BANNER_INSET_VAR);
  }
}

/** A stable callback that hands the given element (or its absence) to
 * state, so effects can depend on the element itself instead of on a ref
 * object that is truthy from the first render. */
function useMeasuredElement(): [BannerMount, HTMLElement | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const set = useCallback<BannerMount>((next) => setElement(next), []);
  return [set, element];
}

/** Measure the banners the app renders above the chat and keep the
 * `--app-banner-height` variable in sync with them.
 *
 * The caller wires each banner to one of the returned callbacks; the
 * effect runs before paint (the panels must never be drawn at their
 * fallback offset and then jump) and the `ResizeObserver` follows every
 * later change — a banner appearing or leaving, its text wrapping onto
 * another line, or the docked pane narrowing the strip while it is open.
 *
 * Every element the app stacks above the chat needs a callback here: the
 * panels position themselves from the measured band, so a block that
 * skips the hook is a block the panels will overlap. */
export function usePanelInset(): {
  appRef: BannerMount;
  onUpdateBannerMount: BannerMount;
  onServerBannerMount: BannerMount;
} {
  const [appRef, app] = useMeasuredElement();
  const [onUpdateBannerMount, updateBanner] = useMeasuredElement();
  const [onServerBannerMount, serverBanner] = useMeasuredElement();
  const banners = [updateBanner, serverBanner].filter(
    (banner): banner is HTMLElement => banner !== null,
  );

  // The dependency list holds the element identities (not the callbacks
  // reading them): re-observing only when a banner actually entered or
  // left the DOM. Same elements, changed geometry → the observer's own
  // callback handles it. The spread is correct precisely because the
  // list is derived from `banners`.
  useLayoutEffect(() => {
    applyBannerInset(app, banners);
    if (app === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => applyBannerInset(app, banners));
    observer.observe(app);
    for (const banner of banners) observer.observe(banner);
    return () => observer.disconnect();
  }, [app, ...banners]);

  return { appRef, onUpdateBannerMount, onServerBannerMount };
}
