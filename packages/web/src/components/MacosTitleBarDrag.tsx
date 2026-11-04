import { type MouseEvent, useRef } from "preact/compat";
import { windowApi } from "../shell.ts";

/**
 * The grab surface in the macOS native title bar's height.
 *
 * `titleBarStyle: "overlay"` puts a transparent native bar over the page.
 * The page is inset below it (`.app.macos`) so its tabs and menus receive
 * clicks, which leaves that top strip with no page content to grab: the
 * traffic lights are the OS's, but the rest of the height belongs to the
 * page. This fixed surface covers that height to the right of the traffic
 * lights and starts the same bridge drag as the page's own strip, so the
 * window moves from anywhere along the top — not only from the tab strip.
 *
 * The left edge stays clear for the native close / minimize / zoom buttons.
 */
export function MacosTitleBarDrag() {
  /** Where the second press of a double click landed. The first press
   *  starts a drag, so the zoom is decided on the release. */
  const doubleClickAt = useRef<{ x: number; y: number } | null>(null);

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.detail === 2) {
      doubleClickAt.current = { x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    windowApi.startDrag().catch(() => {});
  };

  const onMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    const start = doubleClickAt.current;
    doubleClickAt.current = null;
    if (e.button !== 0 || e.detail !== 2 || start === null) return;
    // Match the system: a double click that moved is not a zoom.
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 4) {
      return;
    }
    windowApi.toggleMaximize().catch(() => {});
  };

  return (
    <div
      className="macos-titlebar-drag"
      aria-hidden="true"
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    />
  );
}
