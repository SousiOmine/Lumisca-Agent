import { type MouseEvent, type ReactNode, useState } from "preact/compat";
import { IconCopy, IconMinus, IconSquare, IconX } from "@tabler/icons-preact";
import { shellCall, type ShellState, windowApi } from "../shell.ts";
import { useVisibleInterval } from "../hooks/useVisibleInterval.ts";
import { useT } from "../i18n.ts";
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
  /** Open the mode-selection screen (see AppMenu). */
  onSwitchMode: () => void;
  /** Open settings → 接続先サーバー (the picker's "manage" entry). */
  onManageConnections: () => void;
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
 *   by the page could not match them. The strip therefore starts to the
 *   right of them (`--traffic-inset`, see chrome.css) and the empty area
 *   is left to the system for dragging and double-click zooming, so this
 *   component does not route those through the bridge there.
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
}: TitleBarProps) {
  const t = useT();
  const [state, setState] = useState<ShellState | null>(null);

  // One read at a time, re-armed by the effect below: a fetch that is still
  // in flight must not stack a second one behind it. The whole state is
  // kept (not just the maximized flag): the picker names the server from
  // it, and the platform decides which controls to draw.
  const [pollMs, setPollMs] = useState(POLL_MS);
  useVisibleInterval(() => {
    void shellCall<ShellState>("state").then(
      (next) => {
        setState(next);
        setPollMs(POLL_MS);
      },
      () => {
        setState(null);
        // Back off when the bridge is absent (a plain browser): it cannot
        // come up later in this page.
        setPollMs(IDLE_POLL_MS);
      },
    );
  }, pollMs);

  // Plain browser: no shell bridge, so no window chrome — the tab bar
  // renders on its own with its default (full bar) styles.
  if (state === null) return <>{children}</>;

  const nativeControls = state.platform === "macos";

  /** Tabs, the app menu, the connection picker (its popover extends below
   * the strip) and the window buttons must stay clickable, not drag. */
  const isInteractive = (e: MouseEvent<HTMLDivElement>) =>
    (e.target as HTMLElement).closest("button, .tab, .connection-picker") !==
      null;

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    // The native title bar already moves and zooms the window.
    if (nativeControls || e.button !== 0 || isInteractive(e)) return;
    e.preventDefault();
    windowApi.startDrag().catch(() => {});
  };

  const onDblClick = (e: MouseEvent<HTMLDivElement>) => {
    if (nativeControls || isInteractive(e)) return;
    windowApi.toggleMaximize().catch(() => {});
  };

  return (
    <div
      className={`titlebar${nativeControls ? " titled" : ""}`}
      onMouseDown={onMouseDown}
      onDblClick={onDblClick}
    >
      {children}
      <div className="titlebar-controls">
        {
          /* Which server this window shows. The window's own state, so it
         * belongs to the window chrome rather than to a settings dialog: a
         * page served by a remote machine looks exactly like the local one. */
        }
        <ConnectionPicker onManage={onManageConnections} />
        <AppMenu
          onNew={onNew}
          onOpenRecent={onOpenRecent}
          onOpenSettings={onOpenSettings}
          onQuit={onQuit}
          onSwitchMode={onSwitchMode}
          isDesktop
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
              title={state.maximized
                ? t("chrome.titleBar.restore")
                : t("chrome.titleBar.maximize")}
              aria-label={state.maximized
                ? t("chrome.titleBar.restore")
                : t("chrome.titleBar.maximize")}
            >
              {state.maximized
                ? <IconCopy size={13} />
                : <IconSquare size={12} />}
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
