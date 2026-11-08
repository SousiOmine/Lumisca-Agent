import { useEffect, useRef, useState } from "preact/compat";
import {
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconX,
} from "@tabler/icons-preact";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import { useT } from "../i18n.ts";

/** The "update ready" strip under the title bar (renders nothing when no
 * updater has something to install). Owns its dismissed state: a new
 * update finishing its download (ready false → true), or an applied update
 * waiting for its restart, re-shows it — but a poll that keeps the same
 * state does not.
 *
 * Two shapes share the strip: the desktop shell installs and restarts the
 * app in one step, while a standalone server installs the files first and
 * takes effect at the next start (the restart is its own decision).
 *
 * Installing is a state of its own: replacing the files takes seconds and
 * nothing else moves until it ends, so the strip says so and takes the
 * button away. Without it the click looks ignored until the restart offer
 * appears.
 */
export function UpdateBanner({ update }: { update: UpdateControls }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  const status = update.status;
  const server = update.source === "server";
  const restartPending = server && status?.restartPending === true;
  const installing = status?.installing === true;
  const ready = status?.ready === true && !restartPending && !installing;
  const actionable = ready || restartPending || installing;

  // Re-show the banner when the state moves on (a finished download, an
  // applied update), but not on every poll that keeps it there.
  const previousRef = useRef<string | null>(null);
  useEffect(() => {
    const current = !actionable
      ? null
      : installing
      ? `install:${status?.latestVersion}`
      : restartPending
      ? `restart:${status?.appliedVersion}`
      : `ready:${status?.latestVersion}`;
    if (current !== null && current !== previousRef.current) {
      setDismissed(false);
    }
    previousRef.current = current;
  }, [
    actionable,
    installing,
    restartPending,
    status?.appliedVersion,
    status?.latestVersion,
  ]);

  if (!actionable || dismissed) return null;

  const canRestart = restartPending && status?.restartMode !== "none";
  // The server installs the files and takes effect at the next start; the
  // desktop shell bundles the restart with the install, so only it has to
  // warn about the app going down.
  const readyText = t("chrome.update.ready", {
    version: status?.latestVersion ?? "",
  });
  const restartText = status?.restartMode === "supervisor"
    ? t("chrome.update.restartNote") + t("chrome.update.systemdNote")
    : canRestart
    ? t("chrome.update.restartNote")
    : t("chrome.update.nextStart");
  const text = installing
    ? t("chrome.update.installing", { version: status?.latestVersion ?? "" })
    : restartPending
    ? t("chrome.update.downloaded", { version: status?.appliedVersion ?? "" }) +
      restartText
    : server
    ? readyText
    : readyText + t("chrome.update.installRestart");

  return (
    <div className="update-banner">
      {installing
        ? <IconLoader2 size={16} className="spin" />
        : restartPending
        ? <IconRefresh size={16} />
        : <IconDownload size={16} />}
      <span className="update-banner-text">{text}</span>
      {installing
        ? (
          <button type="button" className="btn push" disabled>
            {t("chrome.update.installingButton")}
          </button>
        )
        : restartPending
        ? canRestart && (
          <button type="button" className="btn push" onClick={update.restart}>
            {t("chrome.update.restartNow")}
          </button>
        )
        : (
          <button type="button" className="btn push" onClick={update.install}>
            {t("chrome.update.installNow")}
          </button>
        )}
      <button
        type="button"
        className="btn"
        onClick={() => setDismissed(true)}
        title={t("chrome.update.dismiss")}
        aria-label={t("chrome.update.dismiss")}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
