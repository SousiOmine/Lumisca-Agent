import { withTimeout } from "@lumisca/core/shared";
import { request } from "./api-client.ts";

/** Bridge to the desktop shell. The settings UI is served by the
 * (possibly remote) server, so it cannot call Tauri commands; instead it
 * calls the shell's loopback listener (`/shell/<action>`, see
 * packages/desktop/src-tauri/src/bridge_server.rs).
 *
 * The origin is injected by the shell as `window.__LUMISCA_BRIDGE__` — an
 * initialization script, so every navigation of the window carries it
 * (the splash, the local server, a remote one). It is deliberately not a
 * custom URI scheme (`lumisca://`): WebView2 (Windows) re-homes such a
 * scheme to http, but WKWebView (macOS) refuses to fetch one from an
 * http(s) page, so the bridge never answered there and the title bar — the
 * connection picker and the window controls — never rendered. In a plain
 * browser nothing sets the global, and shellAvailable() reports false.
 */

export interface ShellState {
  mode: "local" | "remote";
  url: string | null;
  /** Name of the registry entry the window was switched to (the shell
   * remembered it beside the URL), or null when the switch was not made from
   * the registry — a server reached from the startup screen has no name to
   * show, and the picker falls back to the URL's host. */
  name: string | null;
  /** Whether the main window is maximized (custom title bar icon). */
  maximized: boolean;
  /** The OS the shell runs on. The page is served by a possibly remote
   * machine, so its own environment says nothing about the window it is
   * displayed in: the window controls follow this value. */
  platform: "macos" | "windows" | "linux";
}

declare global {
  /** Embedded by the server when LUMISCA_TOKEN auth is enabled (also
   * declared in api.ts; repeated here so this module type-checks
   * standalone — global augmentations merge). */
  var __LUMISCA_TOKEN__: string | undefined;
  /** The desktop shell's bridge origin (`http://127.0.0.1:<port>/shell`),
   * injected as the main window's initialization script. Absent in a plain
   * browser and in the browser lab. */
  var __LUMISCA_BRIDGE__: string | undefined;
}

/** Bridge base URL, or undefined outside the desktop shell. */
const BRIDGE = globalThis.__LUMISCA_BRIDGE__;

/** Auth token of the currently connected server. The shell bridge only
 * answers requests carrying it as `key`, so only the page served by that
 * server can drive the bridge. */
const key = globalThis.__LUMISCA_TOKEN__;

export async function shellCall<T>(
  action: string,
  params: Record<string, string> = {},
): Promise<T> {
  if (BRIDGE === undefined) {
    // Plain browser: there is no shell, and the callers (the title bar, the
    // update controls) read the rejection as "desktop-only".
    throw new Error("the desktop shell is not available");
  }
  const query = new URLSearchParams(params);
  if (key) query.set("key", key);
  const res = await fetch(`${BRIDGE}/${action}?${query}`);
  const body = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  return body as T;
}

/** Whether the desktop shell's bridge is reachable (false in browsers).
 * Bounded by a timeout so a slow answer does not stall the UI. */
export function shellAvailable(): Promise<boolean> {
  if (BRIDGE === undefined) return Promise.resolve(false);
  return withTimeout(
    shellCall<ShellState>("state").then(
      () => true,
      () => false,
    ),
    2500,
    false,
  );
}

/** Whether the OS folder picker can be used: the shell bridge must answer
 * AND display the local server (only then are picked paths on the machine
 * owning the workspaces; against a remote server they would be wrong). */
export function nativeFolderPickerAvailable(): Promise<boolean> {
  if (BRIDGE === undefined) return Promise.resolve(false);
  return withTimeout(
    shellCall<ShellState>("state").then(
      (s) => s.mode === "local",
      () => false,
    ),
    2500,
    false,
  );
}

/** Open the OS folder picker through the shell bridge. Returns the picked
 * path, or null when the user cancelled. */
export async function pickFolder(): Promise<string | null> {
  const res = await shellCall<{ path: string | null }>("pick-folder");
  return res.path;
}

/** Auto-update state of the app the page belongs to. Two producers share
 * this shape: the desktop shell bridge (`update/status`) and the standalone
 * server's own updater (`/api/update/status`). The fields only one of them
 * can fill are optional, and `hooks/useUpdateStatus.ts` reports which one
 * answered. */
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
  /** サーバー単体のアップデーターのみ: この構成で自己更新できるか。 */
  supported?: boolean;
  /** サーバー単体のアップデーターのみ: できない理由 (supported が false のとき)。 */
  unsupportedReason?: string | null;
  /** サーバー単体のアップデーターのみ: 適用済みのファイルが実行中プロセス
   * と異なるバージョンか (再起動で有効になる)。 */
  restartPending?: boolean;
  /** サーバー単体のアップデーターのみ: 適用済みバージョン。 */
  appliedVersion?: string | null;
  /** サーバー単体のアップデーターのみ: 再起動の可否 ("none" は監視側に任せる、
   * "supervisor" は監視プロセス (systemd) が新しいバイナリを起動する)。 */
  restartMode?: "self" | "none" | "supervisor";
  /** サーバー単体のアップデーターのみ: 適用後に自動で再起動するか。 */
  autoRestart?: boolean;
  /** サーバー単体のアップデーターのみ: 再起動処理中 (この応答の後に落ちる)。 */
  restarting?: boolean;
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
  /** Bring the main window to the front (restore when minimized, then
   * focus). Used after a background-notification toast when the OS does
   * not activate the app on its own. */
  focus: () => shellCall("window/focus"),
  /** Start moving the window (the page has no Tauri IPC, so the native
   * `data-tauri-drag-region` path is unavailable; the bridge starts the
   * OS drag instead). */
  startDrag: () => shellCall("window/start-drag"),
};

/** Main-window visibility reported by the shell bridge (`window/state`).
 * The agent-event notifier uses it to tell "the user can see us" apart
 * from "we exist but are hidden" (minimized, behind another app, on
 * another virtual desktop). */
export interface WindowState {
  focused: boolean;
  minimized: boolean;
  visible: boolean;
  maximized: boolean;
}

/** Query the main window's visibility. Rejects outside the desktop
 * shell (callers fall back to `document.hidden` there). */
export const windowStateApi = {
  getState: () => shellCall<WindowState>("window/state"),
};

/** Agent-event notifications shown while the window is hidden. Every call
 * carries the fresh display text; the shell truncates and shows it as an
 * OS notification (plus a taskbar flash), and never fails the caller —
 * a denied notification path only logs in the shell. `urgent` (the
 * ask-tool question) keeps the toast on screen longer on Windows.
 * Rejects outside the desktop shell (callers treat that as
 * "desktop-only, skip"). */
export const notifyApi = {
  notify: (title: string, body: string, urgent: boolean) =>
    shellCall<{ ok: boolean }>("notify", {
      title,
      body,
      urgent: String(urgent),
    }),
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

/**
 * Auto-update actions of the standalone server hosting this page
 * (`/api/update/*`, see packages/server/routes/update.ts). Used when the
 * page runs outside the desktop shell: the server then owns its own files,
 * while in the desktop the shell's updater owns the app (and the server is
 * just one of its resources). Both answer the same status shape, so the UI
 * keeps a single implementation.
 *
 * The method is part of that contract, so every call names it: `status` is
 * the only GET (a read), all actions are POST (the server registers them
 * that way — an action mutates the installation, and a mutation must not
 * ride on a GET). Inferring the method from the presence of a body, as this
 * module first did, sent the four body-less actions (`check`, `download`,
 * `install`, `restart`) as GETs, which the server answers with 404: every
 * update button of a browser-hosted page was dead, silently.
 */
export const serverUpdateApi = {
  status: () => serverUpdate<UpdateStatus>("status", "GET"),
  setAuto: (enabled: boolean) =>
    serverUpdate<UpdateStatus>("set-auto", "POST", { enabled }),
  setAutoRestart: (enabled: boolean) =>
    serverUpdate<UpdateStatus>("set-auto-restart", "POST", { enabled }),
  check: () => serverUpdate<UpdateStatus>("check", "POST"),
  download: () => serverUpdate<UpdateStatus>("download", "POST"),
  install: () => serverUpdate<UpdateStatus>("install", "POST"),
  restart: () => serverUpdate<UpdateStatus>("restart", "POST"),
};

function serverUpdate<T>(
  action: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  return request<T>(`/api/update/${action}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Local server liveness reported by the shell bridge (`server/status`).
 * The page cannot tell "server crashed" apart from "server hung" on its
 * own — both just stop answering — so the shell (which owns the child
 * handle and captures its output) classifies it. `logTail` is the recent
 * server output for copy-paste diagnosis (included while running too, so
 * a hang can be diagnosed the same way as a crash). */
export type ServerLiveness = "running" | "exited" | "none";

export interface LocalServerStatus {
  /** Which server the page is talking to (`local` | `remote`). While a
   * remote server is displayed, the desktop shell's local child process is
   * not behind this page at all — even if it is still running — so the
   * connection-lost banner must not blame it. */
  mode: "local" | "remote";
  liveness: ServerLiveness;
  port: number | null;
  /** Process exit code when the child already exited (null = signaled). */
  exitCode: number | null;
  logTail: string;
}

/** Local server diagnostics through the shell bridge. `status` classifies
 * the child (running / exited / none) with its captured output; `restart`
 * kills the dead child, starts a fresh server and navigates to it (the
 * connection-lost banner's "再起動" button). Plain browsers (no shell)
 * reject both calls. */
export const serverApi = {
  status: () => shellCall<LocalServerStatus>("server/status"),
  restart: () => shellCall<{ ok: boolean; url: string }>("server/restart"),
};
