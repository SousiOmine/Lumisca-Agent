/**
 * What a left press on the undecorated window's caption strip means. Used by
 * `components/TitleBar.tsx`, and copied to the shell's splash
 * (`packages/desktop/src-tauri/frontend/splash.js`, which cannot import it).
 *
 * Windows and Linux decide the double click on the second press, not on
 * `dblclick`: the first press starts the OS's window-move loop, and that loop
 * holds the mouse capture, so the release a `dblclick` would be counted from
 * never reaches the page. The second press does arrive, carrying the click
 * count the OS assigned it (the `WM_LBUTTONDBLCLK` press, `detail === 2`),
 * and that is where the maximize / restore belongs. Tauri's own drag-region
 * script follows the same rule. macOS keeps its zoom on the release: the
 * system cancels it when the pointer moved between the two presses.
 */

/** What one press on the caption strip does. */
export type CaptionPress = "drag" | "toggle-maximize" | "none";

/** The action of a left press that landed on the strip itself, by
 * `MouseEvent.detail`. A press on a tab, the app menu, the connection picker
 * or a window button is that control's, and the caller never asks this. */
export function captionPress(detail: number): CaptionPress {
  if (detail === 2) return "toggle-maximize";
  // A third press is still the same caption sequence. Acting on it would
  // toggle the window back to where the second press left it.
  if (detail === 1) return "drag";
  return "none";
}
