import { useEffect, useRef, useState } from "preact/compat";
import { IconDownload, IconRefresh, IconX } from "@tabler/icons-preact";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";

/** The "update ready" strip under the title bar (renders nothing when no
 * updater has something to install). Owns its dismissed state: a new
 * update finishing its download (ready false → true), or an applied update
 * waiting for its restart, re-shows it — but a poll that keeps the same
 * state does not.
 *
 * Two shapes share the strip: the desktop shell installs and restarts the
 * app in one step, while a standalone server installs the files first and
 * takes effect at the next start (the restart is its own decision). */
export function UpdateBanner({ update }: { update: UpdateControls }) {
  const [dismissed, setDismissed] = useState(false);
  const status = update.status;
  const server = update.source === "server";
  const restartPending = server && status?.restartPending === true;
  const ready = status?.ready === true && !restartPending;
  const actionable = ready || restartPending;

  // Re-show the banner when the state moves on (a finished download, an
  // applied update), but not on every poll that keeps it there.
  const previousRef = useRef<string | null>(null);
  useEffect(() => {
    const current = !actionable
      ? null
      : restartPending
      ? `restart:${status?.appliedVersion}`
      : `ready:${status?.latestVersion}`;
    if (current !== null && current !== previousRef.current) {
      setDismissed(false);
    }
    previousRef.current = current;
  }, [
    actionable,
    restartPending,
    status?.appliedVersion,
    status?.latestVersion,
  ]);

  if (!actionable || dismissed) return null;

  const canRestart = restartPending && status?.restartMode !== "none";
  // The server installs the files and takes effect at the next start; the
  // desktop shell bundles the restart with the install, so only it has to
  // warn about the app going down.
  const readyText =
    `新しいバージョン（v${status?.latestVersion}）にアップデートできます。`;
  const restartText = status?.restartMode === "supervisor"
    ? "再起動すると適用されます（※実行中のセッションは停止します）。" +
      "systemd が新しいバージョンで起動します。"
    : canRestart
    ? "アプリを再起動すると適用されます（※実行中のセッションは停止します）。"
    : "次回の起動で適用されます（LUMISCA_UPDATE_RESTART=none）。";
  const text = restartPending
    ? `Lumisca v${status?.appliedVersion} をダウンロードしました。` +
      restartText
    : server
    ? readyText
    : readyText + "インストールするとアプリが再起動します。";

  return (
    <div className="update-banner">
      {restartPending ? <IconRefresh size={16} /> : <IconDownload size={16} />}
      <span className="update-banner-text">{text}</span>
      {restartPending
        ? canRestart && (
          <button type="button" className="btn push" onClick={update.restart}>
            今すぐ再起動
          </button>
        )
        : (
          <button type="button" className="btn push" onClick={update.install}>
            今すぐインストール
          </button>
        )}
      <button
        type="button"
        className="btn"
        onClick={() => setDismissed(true)}
        title="後で閉じる"
        aria-label="後で閉じる"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
