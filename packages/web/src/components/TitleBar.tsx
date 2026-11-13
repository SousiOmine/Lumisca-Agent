import type { AppMode } from "@lumisca/core/shared";
import { IconCopy, IconMinus, IconSquare, IconX } from "@tabler/icons-preact";
import {
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "preact/compat";
import { useVisibleInterval } from "../hooks/useVisibleInterval.ts";
import { useT } from "../i18n.ts";
import {
  inDesktopShell,
  type ShellState,
  shellPlatform,
  shellState,
  windowApi,
} from "../shell.ts";
import { AppMenu } from "./AppMenu.tsx";
import { ConnectionPicker } from "./ConnectionPicker.tsx";

/** Poll interval while the shell is reachable: the connection picker names
 * the current server from it, so a modest interval is fine. */
const POLL_MS = 500;
/** Back-off when the shell is unreachable (plain browser) — the bridge
 * cannot come up later in the same page, so poll rarely. */
const IDLE_POLL_MS = 5_000;

interface TitleBarProps {
  /** The tab bar: rendered inside this strip on desktop, standalone in a
   * plain browser (where the strip is not rendered). */
  children: ReactNode;
  onNew: () => void;
  /** Open the recent (closed) sessions modal. */
  onOpenRecent: () => void;
  onOpenSettings: () => void;
  onQuit: () => void;
  /** Switch to the other mode, in one press (see AppMenu). */
  onSwitchMode: (mode: AppMode) => void;
  /** Open settings → 接続先サーバー (the picker's "manage" entry). */
  onManageConnections: () => void;
  /** The mode this window shows: the app menu's switch entry names the other
   * one, and only code mode offers the tab actions (see AppMenu). */
  mode: AppMode;
}

/** Window chrome for the desktop window: a single strip holding the tab
 * bar, the app menu, the connection picker and the window controls.
 *
 * Which controls are drawn is the platform's convention, not a choice:
 *
 * - macOS keeps the OS's own window controls (`decorations` +
 *   `titleBarStyle: "overlay"` in tauri.macos.conf.json). The traffic
 *   lights are the native ones, inset into the transparent title bar, and
 *   the window server owns their look, hover and placement — a copy drawn
 *   by the page could not match them. The native bar covers the top 28
 *   points, so the page's strip starts below it (`.app.macos` in
 *   chrome.css) rather than underneath the traffic lights, where its
 *   buttons would not receive clicks. The strip is still the window's
 *   toolbar: dragging it moves the window through the bridge, and a double
 *   click zooms it.
 * - Windows and Linux are undecorated (`decorations: false`), so the page
 *   draws square minimize / maximize / close buttons at the right edge and
 *   moves the window through the bridge (`window/start-drag`).
 *
 * The page is served from http://127.0.0.1 (or a remote server), so it has
 * no Tauri IPC and the native `data-tauri-drag-region` path cannot work. */
export function TitleBar({
  children,
  onNew,
  onOpenRecent,
  onOpenSettings,
  onQuit,
  onSwitchMode,
  onManageConnections,
  mode,
}: TitleBarProps) {
  const t = useT();
  const [state, setState] = useState<ShellState | null>(null);

  // One read at a time, re-armed by the effect below: a fetch that is still
  // in flight must not stack a second one behind it. The whole state is
  // kept (not just the maximized flag): the picker names the server from it.
  const [pollMs, setPollMs] = useState(POLL_MS);
  useVisibleInterval(() => {
    void shellState.read().then(
      (next) => {
        setState(next);
        setPollMs(POLL_MS);
      },
      () => {
        // The bridge refused or did not answer: the strip stays where it is
        // (the controls are the window's only way out) and the poll backs
        // off. Dropping the state here would take the buttons and the drag
        // handle down with it — an unclosable, unmovable window.
        setPollMs(IDLE_POLL_MS);
      },
    );
  }, pollMs);

  // A plain browser has no shell, so no window chrome: the tab bar renders
  // on its own with its default (full bar) styles. The decision is the
  // build's, not an answer of the bridge — see `inDesktopShell`.
  if (!inDesktopShell()) return <>{children}</>;

  const nativeControls = shellPlatform === "macos";
  // Until the bridge answers, the window is drawn restored; the answer only
  // swaps the glyph.
  const maximized = state?.maximized === true;

  /** Tabs, the app menu, the connection picker (their popovers extend below
   * the strip) and the window buttons must stay clickable, not drag. */
  const isInteractive = (e: MouseEvent<HTMLDivElement>) =>
    (e.target as HTMLElement).closest(
      "button, .tab, .app-menu, .connection-picker",
    ) !== null;

  /** Where the second press of a macOS double click landed. The first press
   *  starts a drag, so the zoom is decided on the release (see onMouseUp). */
  const doubleClickAt = useRef<{ x: number; y: number } | null>(null);

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isInteractive(e)) return;
    // macOS: the strip is below the native title bar, but it is still the
    // window's toolbar. A drag here goes through the bridge like Windows
    // and Linux; a double click is the system's zoom gesture, so remember
    // its position instead of starting a second drag on the second press.
    if (nativeControls && e.detail === 2) {
      doubleClickAt.current = { x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    windowApi.startDrag().catch(() => {});
  };

  const onMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (nativeControls && e.button === 0 && e.detail === 2) {
      const start = doubleClickAt.current;
      doubleClickAt.current = null;
      // The system cancels the zoom when the pointer moved between the two
      // presses; do the same so a sloppy double click does not resize.
      if (
        start !== null &&
        !isInteractive(e) &&
        Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) <= 4
      ) {
        windowApi.toggleMaximize().catch(() => {});
      }
      return;
    }
    doubleClickAt.current = null;
  };

  const onDblClick = (e: MouseEvent<HTMLDivElement>) => {
    // macOS zooms on mouseup (the first press starts a drag); the other
    // platforms do not have the native title bar to consume the drag.
    if (nativeControls || isInteractive(e)) return;
    windowApi.toggleMaximize().catch(() => {});
  };

  return (
    <div
      className="titlebar"
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onDblClick={onDblClick}
    >
      {children}
      <div className="titlebar-controls">
        {/* Which server this window shows. The window's own state, so it
         * belongs to the window chrome rather than to a settings dialog: a
         * page served by a remote machine looks exactly like the local one. */}
        <ConnectionPicker onManage={onManageConnections} />
        <AppMenu
          onNew={onNew}
          onOpenRecent={onOpenRecent}
          onOpenSettings={onOpenSettings}
          onQuit={onQuit}
          onSwitchMode={onSwitchMode}
          isDesktop
          mode={mode}
          buttonClass="titlebar-btn"
        />
        {!nativeControls && (
          <>
            <button
              type="button"
              className="titlebar-btn"
              onClick={() => windowApi.minimize()}
              title={t("chrome.titleBar.minimize")}
              aria-label={t("chrome.titleBar.minimize")}
            >
              <IconMinus size={15} />
            </button>
            <button
              type="button"
              className="titlebar-btn"
              onClick={() => windowApi.toggleMaximize()}
              title={
                maximized
                  ? t("chrome.titleBar.restore")
                  : t("chrome.titleBar.maximize")
              }
              aria-label={
                maximized
                  ? t("chrome.titleBar.restore")
                  : t("chrome.titleBar.maximize")
              }
            >
              {maximized ? <IconCopy size={13} /> : <IconSquare size={12} />}
            </button>
            <button
              type="button"
              className="titlebar-btn close"
              onClick={() => windowApi.close()}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <IconX size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
