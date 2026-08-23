import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import {
  IconBrowser,
  IconCopy,
  IconMinus,
  IconSquare,
  IconX,
} from "@tabler/icons-react";
import { shellCall, type ShellState, windowApi } from "../shell.ts";
import { AppMenu } from "./AppMenu.tsx";

/** Poll interval while the shell is reachable: only the maximize/restore
 * icon depends on the window state, so a modest interval is fine. */
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
  /** Browser lab pane state (desktop): whether the lab exists and
   * whether the pane is shown. When given, a toggle button is rendered
   * next to the app menu. */
  browserOpen?: boolean;
  browserVisible?: boolean;
  onToggleBrowser?: () => void;
}

/** Window chrome for the undecorated desktop window (see
 * tauri.conf.json): a single strip holding the tab bar on the left and
 * the app menu + minimize / maximize / close buttons on the right. The
 * empty area of the strip is the drag handle.
 *
 * The page is served from http://127.0.0.1 (or a remote server), so it
 * has no Tauri IPC and the native `data-tauri-drag-region` path cannot
 * work; dragging and double-click-to-maximize go through the shell
 * bridge instead. */
export function TitleBar({
  children,
  onNew,
  onOpenRecent,
  onOpenSettings,
  onQuit,
  browserOpen = false,
  browserVisible = false,
  onToggleBrowser,
}: TitleBarProps) {
  const [available, setAvailable] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const state = await shellCall<ShellState>("state");
        if (cancelled) return;
        setAvailable(true);
        setMaximized(state.maximized);
        timer = setTimeout(poll, POLL_MS);
      } catch {
        if (cancelled) return;
        setAvailable(false);
        timer = setTimeout(poll, IDLE_POLL_MS);
      }
    };
    timer = setTimeout(poll, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  // Plain browser: no shell bridge, so no window chrome — the tab bar
  // renders on its own with its default (full bar) styles.
  if (!available) return <>{children}</>;

  /** Tabs, the app menu and window buttons must stay clickable, not
   * drag. */
  const isInteractive = (e: MouseEvent) =>
    (e.target as HTMLElement).closest("button, .tab") !== null;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || isInteractive(e)) return;
    e.preventDefault();
    windowApi.startDrag().catch(() => {});
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (isInteractive(e)) return;
    windowApi.toggleMaximize().catch(() => {});
  };

  return (
    <div
      className="titlebar"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {children}
      <div className="titlebar-controls">
        {onToggleBrowser && (
          <button
            type="button"
            className={`titlebar-btn${browserOpen ? " active" : ""}`}
            onClick={onToggleBrowser}
            title={browserVisible
              ? "ブラウザペインを隠す"
              : "ブラウザペインを表示"}
            aria-label={browserVisible
              ? "ブラウザペインを隠す"
              : "ブラウザペインを表示"}
          >
            <IconBrowser size={15} />
            {
              /* A hidden-but-alive lab: the agent may still be operating
             * the browser in the background. */
            }
            {browserOpen && !browserVisible && (
              <span className="titlebar-btn-dot" />
            )}
          </button>
        )}
        <AppMenu
          onNew={onNew}
          onOpenRecent={onOpenRecent}
          onOpenSettings={onOpenSettings}
          onQuit={onQuit}
          isDesktop
          buttonClass="titlebar-btn"
          browserPaneOpen={browserOpen}
        />
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => windowApi.minimize()}
          title="最小化"
          aria-label="最小化"
        >
          <IconMinus size={15} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => windowApi.toggleMaximize()}
          title={maximized ? "元に戻す" : "最大化"}
          aria-label={maximized ? "元に戻す" : "最大化"}
        >
          {maximized ? <IconCopy size={13} /> : <IconSquare size={12} />}
        </button>
        <button
          type="button"
          className="titlebar-btn close"
          onClick={() => windowApi.close()}
          title="閉じる"
          aria-label="閉じる"
        >
          <IconX size={15} />
        </button>
      </div>
    </div>
  );
}
