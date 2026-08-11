/** Bridge to the desktop shell. The settings UI is served by the
 * (possibly remote) server, so it cannot call Tauri commands; instead it
 * fetches the shell bridge URL handled by the Tauri custom protocol.
 *
 * WebView2 cannot fetch non-standard schemes, so wry re-hosts custom
 * protocols as `http://<scheme>.localhost` (which its resource filter
 * intercepts and reverts to `lumisca://` before dispatching). In a plain
 * browser that host does not resolve and shellAvailable() is false.
 */

import type { ConnectionEntry } from "./types.ts";

export interface ShellState {
  mode: "local" | "remote";
  url: string | null;
  name: string | null;
  id: string | null;
}

/** Bridge base URL (the `lumisca://` custom protocol, http-homed for
 * WebView2). */
const BRIDGE = "http://lumisca.localhost/shell";

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

/** Whether the desktop shell bridge is reachable (false in browsers).
 * Bounded by a timeout so a slow DNS failure does not stall the UI. */
export function shellAvailable(): Promise<boolean> {
  const probe = shellCall<ShellState>("state").then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 2500)
  );
  return Promise.race([probe, timeout]);
}

/** Registry entries as exposed by the shell bridge. */
export type ShellServer = ConnectionEntry;

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
