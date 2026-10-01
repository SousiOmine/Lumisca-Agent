import { useEffect } from "preact/compat";

/** The CSS variable the app height is written to. Declared in
 * styles/tokens.css (its default, `100dvh`, is what an environment without
 * visualViewport keeps). */
export const APP_HEIGHT_VAR = "--app-height";

/** Keep the app's height in step with the *visual* viewport so the software
 * keyboard cannot cover the composer.
 *
 * `100dvh` follows the browser's own chrome (a collapsing URL bar) but not
 * the keyboard: on iOS Safari the layout viewport keeps its size while the
 * visual viewport shrinks, and the bottom of the app — the composer — would
 * stay behind the keyboard. Sizing the app to the visual viewport keeps the
 * whole UI inside the visible slice.
 *
 * Pinch-zooming shrinks the visual viewport too, and sizing the app to it
 * there would shrink the layout as the user zooms; the variable is dropped
 * while `scale !== 1` (the token default applies again). The value is
 * written straight to the root element rather than held in state: nothing
 * renders from it, only the stylesheet reads it (the same reason
 * usePanelInset writes its measured height directly). */
export function useAppHeight(): void {
  useEffect(() => {
    const viewport = globalThis.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const apply = () => {
      if (viewport.scale !== 1) {
        root.style.removeProperty(APP_HEIGHT_VAR);
        return;
      }
      root.style.setProperty(
        APP_HEIGHT_VAR,
        `${Math.round(viewport.height)}px`,
      );
    };
    apply();
    // The keyboard opening/closing and the URL bar collapsing both resize
    // the visual viewport; `orientationchange` does as well.
    viewport.addEventListener("resize", apply);
    return () => viewport.removeEventListener("resize", apply);
  }, []);
}
