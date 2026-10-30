import { type MouseEvent, type ReactNode, useState } from "preact/compat";
import { IconCopy, IconMinus, IconSquare, IconX } from "@tabler/icons-preact";
import { shellCall, type ShellState, windowApi } from "../shell.ts";
import { useVisibleInterval } from "../hooks/useVisibleInterval.ts";
import { useT } from "../i18n.ts";
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
  /** Open the mode-selection screen (see AppMenu). */
  onSwitchMode: () => void;
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
  onSwitchMode,
}: TitleBarProps) {
  const t = useT();
  const [available, setAvailable] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // One read at a time, re-armed by the effect below: a fetch that is still
  // in flight must not stack a second one behind it.
  const [pollMs, setPollMs] = useState(POLL_MS);
  useVisibleInterval(() => {
    void shellCall<ShellState>("state").then(
      (state) => {
        setAvailable(true);
        setMaximized(state.maximized);
        setPollMs(POLL_MS);
      },
      () => {
        setAvailable(false);
        // Back off when the bridge is absent (a plain browser): it cannot
        // come up later in this page.
        setPollMs(IDLE_POLL_MS);
      },
    );
  }, pollMs);

  // Plain browser: no shell bridge, so no window chrome — the tab bar
  // renders on its own with its default (full bar) styles.
  if (!available) return <>{children}</>;

  /** Tabs, the app menu and window buttons must stay clickable, not
   * drag. */
  const isInteractive = (e: MouseEvent<HTMLDivElement>) =>
    (e.target as HTMLElement).closest("button, .tab") !== null;

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isInteractive(e)) return;
    e.preventDefault();
    windowApi.startDrag().catch(() => {});
  };

  const onDblClick = (e: MouseEvent<HTMLDivElement>) => {
    if (isInteractive(e)) return;
    windowApi.toggleMaximize().catch(() => {});
  };

  return (
    <div
      className="titlebar"
      onMouseDown={onMouseDown}
      onDblClick={onDblClick}
    >
      {children}
      <div className="titlebar-controls">
        <AppMenu
          onNew={onNew}
          onOpenRecent={onOpenRecent}
          onOpenSettings={onOpenSettings}
          onQuit={onQuit}
          onSwitchMode={onSwitchMode}
          isDesktop
          buttonClass="titlebar-btn"
        />
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
          title={maximized
            ? t("chrome.titleBar.restore")
            : t("chrome.titleBar.maximize")}
          aria-label={maximized
            ? t("chrome.titleBar.restore")
            : t("chrome.titleBar.maximize")}
        >
          {maximized ? <IconCopy size={13} /> : <IconSquare size={12} />}
        </button>
        <button
          type="button"
          className="titlebar-btn close"
          onClick={() => windowApi.close()}
          title={t("chrome.titleBar.close")}
          aria-label={t("chrome.titleBar.close")}
        >
          <IconX size={15} />
        </button>
      </div>
    </div>
  );
}
