import type { UpdateStatus } from "../../shell.ts";
import type { UpdateSource } from "../../hooks/useUpdateStatus.ts";

interface GeneralPanelProps {
  /** null = no updater reachable (a browser against a development server). */
  status: UpdateStatus | null;
  /** Which updater answered ("shell" = the desktop app the user launched,
   * "server" = the standalone server hosting this page). */
  source: UpdateSource | null;
  /** Last bridge/API failure, if any (the status may be stale). */
  bridgeError: string | null;
  onSetAuto: (enabled: boolean) => void;
  onSetAutoRestart: (enabled: boolean) => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRestart: () => void;
  /** Background agent-event notifications (desktop only). */
  notifyEnabled: boolean;
  onNotifyEnabledChange: (enabled: boolean) => void;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** Settings → 一般: app info and the auto-update controls.
 *
 * The update state comes from whichever updater owns the running app: the
 * desktop shell (its own bundle, so installing restarts the app) or, for a
 * packaged standalone server opened in a browser, the server itself (which
 * replaces its files and takes effect at the next start). Same panel, one
 * difference: the server offers an explicit restart. */
export function GeneralPanel(
  {
    status,
    source,
    bridgeError,
    onSetAuto,
    onSetAutoRestart,
    onCheck,
    onDownload,
    onInstall,
    onRestart,
    notifyEnabled,
    onNotifyEnabledChange,
  }: GeneralPanelProps,
) {
  if (status === null) {
    return (
      <div className="settings-pane">
        <p className="settings-note">
          この環境では自動アップデートを利用できません。デスクトップアプリまたは正規パッケージからご利用ください。
        </p>
      </div>
    );
  }

  const server = source === "server";
  const supported = status.supported !== false;
  const percent = status.progress == null
    ? null
    : Math.round(status.progress * 100);
  const restartPending = server && status.restartPending === true;
  const canRestart = restartPending && status.restartMode !== "none";
  const statusText = status.checking
    ? "アップデートを確認中…"
    : restartPending
    ? `v${status.appliedVersion} を適用しました。${
      canRestart
        ? status.restartMode === "supervisor"
          ? "再起動すると有効になります（systemd が新しいバージョンで起動します）。"
          : "再起動すると有効になります。"
        : "次回の起動で有効になります。"
    }`
    : status.ready
    ? `v${status.latestVersion} の${
      server
        ? "アップデートをインストールできます。"
        : "アップデートの準備ができました。"
    }`
    : status.available
    ? `v${status.latestVersion} が利用可能です。`
    : "最新バージョンです。";

  return (
    <div className="settings-pane">
      <div className="update-item">
        <div className="update-info">
          <span className="update-label">
            {server ? "サーバー情報" : "アプリ情報"}
          </span>
          <span className="update-desc">Lumisca</span>
        </div>
        <span className="mono">v{status.currentVersion}</span>
      </div>

      {supported && (
        <>
          <div className="update-item">
            <div className="update-info">
              <span className="update-label">自動アップデート</span>
              <span className="update-desc">
                {server
                  ? "アプリ起動時および定期的に更新を確認し、バックグラウンドで最新版をダウンロードします。次回起動時に自動適用されます。"
                  : "アプリ起動時および定期的に更新を確認し、バックグラウンドで最新版をダウンロードします。"}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={status.autoUpdate}
                onChange={(e) => onSetAuto(e.currentTarget.checked)}
                aria-label="自動アップデート"
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {server && (
            <div className="update-item">
              <div className="update-info">
                <span className="update-label">適用時に自動で再起動</span>
                <span className="update-desc">
                  常時稼働サーバー向けの設定です。無効にした場合は次回起動時に反映されます
                  （※再起動時は実行中のセッションが停止します）。
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={status.autoRestart === true}
                  disabled={status.restartMode === "none"}
                  onChange={(e) => onSetAutoRestart(e.currentTarget.checked)}
                  aria-label="適用時に自動で再起動"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          )}

          <div className="update-status-row">
            {status.downloading
              ? (
                <>
                  <div
                    className="update-progress"
                    role="progressbar"
                    aria-valuenow={percent ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="update-progress-fill"
                      style={{ width: `${percent ?? 0}%` }}
                    />
                  </div>
                  <span className="update-status-text">
                    ダウンロード中 {formatBytes(status.downloaded)}
                    {status.total ? ` / ${formatBytes(status.total)}` : ""}
                  </span>
                  {percent !== null && (
                    <span className="update-percent">{percent}%</span>
                  )}
                </>
              )
              : (
                <>
                  <span className="update-status-text">{statusText}</span>
                  <div className="update-actions">
                    {status.checking
                      ? (
                        <button type="button" className="btn small" disabled>
                          アップデートを確認
                        </button>
                      )
                      : restartPending
                      ? canRestart
                        ? (
                          <button
                            type="button"
                            className="btn push"
                            onClick={onRestart}
                          >
                            再起動
                          </button>
                        )
                        : null
                      : status.ready
                      ? (
                        <button
                          type="button"
                          className="btn push"
                          onClick={onInstall}
                        >
                          インストール
                        </button>
                      )
                      : status.available
                      ? (
                        <button
                          type="button"
                          className="btn push"
                          onClick={onDownload}
                        >
                          ダウンロード
                        </button>
                      )
                      : (
                        <button
                          type="button"
                          className="btn small"
                          onClick={onCheck}
                        >
                          アップデートを確認
                        </button>
                      )}
                  </div>
                </>
              )}
          </div>

          {status.ready && (
            <p className="settings-note">
              {server
                ? "インストールすると、次回の起動で新しいバージョンが有効になります。"
                : "インストールするとアプリが再起動します。"}
            </p>
          )}
          {restartPending && status.restartMode === "none" && (
            <p className="settings-note">
              このサーバーは自動再起動が無効です（LUMISCA_UPDATE_RESTART=none）。監視側で再起動してください。
            </p>
          )}
        </>
      )}

      {!supported && (
        <p className="settings-note">
          このサーバーでは自動アップデートを利用できません
          {status.unsupportedReason ? `: ${status.unsupportedReason}` : "。"}
        </p>
      )}

      {status.error && <div className="error-text">{status.error}</div>}
      {bridgeError && (
        <div className="error-text" role="alert">
          デスクトップシェルと通信できません: {bridgeError}
        </div>
      )}

      {source === "shell" && (
        <div className="update-item">
          <div className="update-info">
            <span className="update-label">バックグラウンド通知</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={notifyEnabled}
              onChange={(e) => onNotifyEnabledChange(e.currentTarget.checked)}
              aria-label="バックグラウンド通知"
            />
            <span className="toggle-slider" />
          </label>
        </div>
      )}
    </div>
  );
}
