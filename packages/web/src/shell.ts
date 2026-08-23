/** Bridge to the desktop shell. The settings UI is served by the
 * (possibly remote) server, so it cannot call Tauri commands; instead it
 * fetches the shell bridge URL handled by the Tauri custom protocol.
 *
 * How the custom protocol is reached depends on the webview engine:
 * - WebView2 (Windows) cannot fetch non-standard schemes, so wry re-homes
 *   the protocol to `http://<scheme>.localhost` (its resource filter
 *   intercepts that host and dispatches to the handler). The bridge must
 *   therefore use the http form there.
 * - WKWebView (macOS) and WebKitGTK (Linux) fetch the `lumisca://` scheme
 *   directly. The host is set to `lumisca.localhost` so the request path
 *   stays `/shell/<action>` — identical to the Windows form — keeping the
 *   Rust-side parsing platform-independent.
 *
 * The platform is detected from the user agent (WebView2 always carries
 * "Windows NT", WKWebView "Macintosh", WebKitGTK "X11; Linux"). In a plain
 * browser neither URL resolves, and shellAvailable() reports false.
 */

export interface ShellState {
  mode: "local" | "remote";
  url: string | null;
  /** Whether the main window is maximized (custom title bar icon). */
  maximized: boolean;
}

/** Bridge base URL (the `lumisca://` custom protocol; http-homed for
 * WebView2 on Windows, fetched as a custom scheme on macOS/Linux). */
const BRIDGE = /Windows/i.test(navigator.userAgent)
  ? "http://lumisca.localhost/shell"
  : "lumisca://lumisca.localhost/shell";

/** Auth token of the currently connected server. The shell bridge only
 * answers requests carrying it as `key`, so only the page served by that
 * server can drive the bridge. */
const key = globalThis.__LUMISCA_TOKEN__;

export async function shellCall<T>(
  action: string,
  params: Record<string, string> = {},
): Promise<T> {
  const query = new URLSearchParams(params);
  if (key) query.set("key", key);
  const res = await fetch(`${BRIDGE}/${action}?${query}`);
  const body = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  return body as T;
}

/** Race a probe against a timeout (the shell bridge may be unreachable —
 * a slow DNS failure must not stall the UI). */
function withTimeout<T>(probe: Promise<T>, fallback: T, ms = 2500): Promise<T> {
  const timeout = new Promise<T>((resolve) =>
    setTimeout(() => resolve(fallback), ms)
  );
  return Promise.race([probe, timeout]);
}

/** Whether the desktop shell bridge is reachable (false in browsers).
 * Bounded by a timeout so a slow DNS failure does not stall the UI. */
export function shellAvailable(): Promise<boolean> {
  return withTimeout(
    shellCall<ShellState>("state").then(
      () => true,
      () => false,
    ),
    false,
  );
}

/** Whether the OS folder picker can be used: the shell bridge must answer
 * AND display the local server (only then are picked paths on the machine
 * owning the workspaces; against a remote server they would be wrong). */
export function nativeFolderPickerAvailable(): Promise<boolean> {
  return withTimeout(
    shellCall<ShellState>("state").then(
      (s) => s.mode === "local",
      () => false,
    ),
    false,
  );
}

/** Open the OS folder picker through the shell bridge. Returns the picked
 * path, or null when the user cancelled. */
export async function pickFolder(): Promise<string | null> {
  const res = await shellCall<{ path: string | null }>("pick-folder");
  return res.path;
}

/** Auto-update state reported by the shell bridge (`update/status`). */
export interface UpdateStatus {
  /** 自動アップデートが有効か (設定の永続値)。 */
  autoUpdate: boolean;
  /** 更新チェック実行中。 */
  checking: boolean;
  /** 新しいバージョンが存在する。 */
  available: boolean;
  /** 最新バージョン (確認済みのときのみ)。 */
  latestVersion: string | null;
  /** ダウンロード実行中。 */
  downloading: boolean;
  /** ダウンロード進捗 0..1 (総サイズ不明時は null)。 */
  progress: number | null;
  downloaded: number | null;
  total: number | null;
  /** ダウンロード完了・インストール待ち。 */
  ready: boolean;
  error: string | null;
  /** 現在実行中のアプリバージョン。 */
  currentVersion: string;
}

/** Quit the desktop application. No-op (rejected) in a plain browser. */
export function quit(): Promise<void> {
  return shellCall("quit").then(() => {});
}

/** Window controls for the custom title bar (the desktop window is
 * undecorated, see tauri.conf.json). No-ops (rejected) in a plain
 * browser. */
export const windowApi = {
  minimize: () => shellCall("window/minimize"),
  toggleMaximize: () => shellCall("window/toggle-maximize"),
  close: () => shellCall("window/close"),
  /** Start moving the window (the page has no Tauri IPC, so the native
   * `data-tauri-drag-region` path is unavailable; the bridge starts the
   * OS drag instead). */
  startDrag: () => shellCall("window/start-drag"),
};

/** Auto-update actions. Every call returns the fresh status so the UI can
 * update immediately without waiting for the next poll. */
export const updateApi = {
  status: () => shellCall<UpdateStatus>("update/status"),
  setAuto: (enabled: boolean) =>
    shellCall<UpdateStatus>("update/set-auto", { enabled: String(enabled) }),
  check: () => shellCall<UpdateStatus>("update/check"),
  download: () => shellCall<UpdateStatus>("update/download"),
  install: () => shellCall<UpdateStatus>("update/install"),
};

/** Docked pane content reported by the shell bridge (`pane/state`). The
 * pane is the right-side panel hosting a native surface inside the app
 * window; today that surface is always the agent's browser lab WebView,
 * but the protocol is kind-based so other content can be hosted later.
 * `kind` is the content type ("browser" today; the UI falls back to a
 * generic display for unknown future kinds) and `label` is the text
 * shown in the pane header (for the browser: the loaded page URL). */
export interface PaneContent {
  kind: string;
  label: string | null;
}

/** Docked pane state reported by the shell bridge (`pane/state`). The
 * pane can be opened/closed from the agent's side and shown/hidden by
 * the user; it is a right-side strip inside the app window (never a
 * separate OS window). */
export interface PaneState {
  /** Whether the pane's surface exists (e.g. the agent opened the
   * browser lab). */
  open: boolean;
  /** Whether the pane is currently shown. Hiding it is a UI choice only:
   * the hosted surface keeps running while it is hidden. */
  visible: boolean;
  /** The content currently hosted in the pane, or null while empty. */
  content: PaneContent | null;
}

/** Docked pane controls. `state` is polled by the UI — the pane also
 * opens/closes from the agent's own tools — and setVisible/toggle return
 * the fresh state so the caller can update immediately. Plain browsers
 * (no shell) reject every call. */
export const paneApi = {
  state: () => shellCall<PaneState>("pane/state"),
  setVisible: (visible: boolean) =>
    shellCall<PaneState>("pane/set-visible", {
      visible: String(visible),
    }),
  toggle: () => shellCall<PaneState>("pane/toggle"),
};
