import type { UpdateStatus } from "../../shell.ts";

interface GeneralPanelProps {
  /** null = desktop shell unreachable (plain browser). */
  status: UpdateStatus | null;
  onSetAuto: (enabled: boolean) => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** Settings → 一般: app info and the desktop auto-update controls. The
 * update state lives in the desktop shell (the page may be served by a
 * remote server), so everything here goes through the shell bridge. */
export function GeneralPanel(
  { status, onSetAuto, onCheck, onDownload, onInstall }: GeneralPanelProps,
) {
  if (status === null) {
    return (
      <div className="settings-pane">
        <p className="settings-note">
          自動アップデートはデスクトップアプリでのみ利用できます。
        </p>
      </div>
    );
  }

  const percent = status.progress == null
    ? null
    : Math.round(status.progress * 100);
  const statusText = status.checking
    ? "更新を確認中..."
    : status.ready
    ? `v${status.latestVersion} のアップデートの準備ができました。`
    : status.available
    ? `v${status.latestVersion} が利用可能です。`
    : "最新バージョンです。";

  return (
    <div className="settings-pane">
      <p className="settings-note">
        アプリのバージョン情報と自動アップデートの設定です。
      </p>

      <div className="update-item">
        <div className="update-info">
          <span className="update-label">アプリ情報</span>
          <span className="update-desc">Lumisca</span>
        </div>
        <span className="mono">v{status.currentVersion}</span>
      </div>

      <div className="update-item">
        <div className="update-info">
          <span className="update-label">自動アップデート</span>
          <span className="update-desc">
            起動時と定期的に新しいバージョンをチェックし、自動でダウンロードします。インストールはこの画面または通知バナーから行えます。
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={status.autoUpdate}
            onChange={(e) => onSetAuto(e.target.checked)}
            aria-label="自動アップデート"
          />
          <span className="toggle-slider" />
        </label>
      </div>

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
          インストールするとアプリが再起動します。
        </p>
      )}
      {status.error && <div className="error-text">{status.error}</div>}
    </div>
  );
}
