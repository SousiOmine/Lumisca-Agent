import { useState } from "preact/compat";
import {
  IconAlertTriangle,
  IconCheck,
  IconClipboard,
} from "@tabler/icons-preact";
import type { ServerHealth } from "../hooks/useServerHealth.ts";
import type { BannerMount } from "../hooks/usePanelInset.ts";
import { useT } from "../i18n.ts";

/** Banner shown when the desktop local server looks unreachable: recent
 * fetch/WS failures plus the shell confirming the child is gone — or
 * failures persisting while the child is alive (a hang). Offers one-click
 * restart (through the shell) and the captured server log tail for
 * copy-paste diagnosis ("勝手に落ちる" reports).
 *
 * The element goes to the app through `onMount` so its layout can measure
 * this strip while it is on screen (see usePanelInset). */
export function ServerDownBanner(
  { health, onMount }: {
    health: ServerHealth;
    /** The strip's element while it is shown, `null` while it is not. */
    onMount?: BannerMount;
  },
) {
  const t = useT();
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const { server } = health;

  if (!health.disconnected) return null;

  const crashed = server?.liveness === "exited";
  const hung = server?.liveness === "running";
  const headline = crashed
    ? (server?.exitCode != null
      ? t("chrome.serverDown.crashed", { code: String(server.exitCode) })
      : t("chrome.serverDown.crashedNoCode"))
    : hung
    ? t("chrome.serverDown.hung")
    : t("chrome.serverDown.unreachable");
  const logTail = server?.logTail?.trim() ?? "";

  const copyLog = async () => {
    const body = [
      headline,
      server?.port != null ? `port: ${server.port}` : "",
      server?.exitCode != null ? `exit code: ${server.exitCode}` : "",
      "",
      logTail || t("chrome.serverDown.noLog"),
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
    <div className="server-down-banner" role="alert" ref={onMount}>
      <IconAlertTriangle size={16} className="server-down-icon" />
      <div className="server-down-body">
        <span className="server-down-text">
          {headline}
          {". "}
          {t("chrome.serverDown.note")}
        </span>
        {health.restartError && (
          <span className="error-text server-down-error">
            {t("chrome.serverDown.restartFailed", {
              error: health.restartError,
            })}
          </span>
        )}
        {showLog && (
          <pre className="server-down-log">
            {logTail || t("chrome.serverDown.noLog")}
          </pre>
        )}
      </div>
      <div className="server-down-actions">
        <button
          type="button"
          className="btn primary small"
          disabled={health.restarting}
          onClick={() => void health.restart()}
        >
          {health.restarting
            ? t("chrome.serverDown.restarting")
            : t("chrome.serverDown.restart")}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => setShowLog((v) => !v)}
          aria-expanded={showLog}
        >
          {showLog
            ? t("chrome.serverDown.hideLog")
            : t("chrome.serverDown.showLog")}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => void copyLog()}
          title={t("chrome.serverDown.copyLogTitle")}
        >
          {copied ? <IconCheck size={14} /> : <IconClipboard size={14} />}
          {t("chrome.serverDown.copyLog")}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={health.dismiss}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}
