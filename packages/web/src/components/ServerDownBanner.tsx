import { useState } from "preact/compat";
import {
  IconAlertTriangle,
  IconCheck,
  IconClipboard,
} from "@tabler/icons-preact";
import type { ServerHealth } from "../hooks/useServerHealth.ts";

/** Banner shown when the desktop local server looks unreachable: recent
 * fetch/WS failures plus the shell confirming the child is gone — or
 * failures persisting while the child is alive (a hang). Offers one-click
 * restart (through the shell) and the captured server log tail for
 * copy-paste diagnosis ("勝手に落ちる" reports). */
export function ServerDownBanner({ health }: { health: ServerHealth }) {
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const { server } = health;

  if (!health.disconnected) return null;

  const crashed = server?.liveness === "exited";
  const hung = server?.liveness === "running";
  const headline = crashed
    ? `ローカルサーバーが終了しました${
      server?.exitCode != null ? ` (exit code ${server.exitCode})` : ""
    }`
    : hung
    ? "ローカルサーバーが応答しません (ハングの可能性)"
    : "ローカルサーバーに接続できません";
  const logTail = server?.logTail?.trim() ?? "";

  const copyLog = async () => {
    const body = [
      headline,
      server?.port != null ? `port: ${server.port}` : "",
      server?.exitCode != null ? `exit code: ${server.exitCode}` : "",
      "",
      logTail || "(サーバーログは空です)",
    ].filter((line, i) => i < 3 || line !== "").join("\n");
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: the <pre> below stays selectable.
    }
  };

  return (
    <div className="server-down-banner" role="alert">
      <IconAlertTriangle size={16} className="server-down-icon" />
      <div className="server-down-body">
        <span className="server-down-text">
          {headline}。作業内容は保存されています。サーバーを再起動すると続けられます。
        </span>
        {health.restartError && (
          <span className="error-text server-down-error">
            再起動に失敗しました: {health.restartError}
          </span>
        )}
        {showLog && (
          <pre className="server-down-log">{logTail || "(サーバーログは空です)"}</pre>
        )}
      </div>
      <div className="server-down-actions">
        <button
          type="button"
          className="btn primary small"
          disabled={health.restarting}
          onClick={() => void health.restart()}
        >
          {health.restarting ? "再起動中…" : "サーバーを再起動"}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => setShowLog((v) => !v)}
          aria-expanded={showLog}
        >
          {showLog ? "ログを隠す" : "ログを表示"}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => void copyLog()}
          title="サーバーログをクリップボードにコピー"
        >
          {copied ? <IconCheck size={14} /> : <IconClipboard size={14} />}
          ログをコピー
        </button>
        <button
          type="button"
          className="btn small"
          onClick={health.dismiss}
          title="閉じる"
          aria-label="閉じる"
        >
          閉じる
        </button>
      </div>
    </div>
  );
}
