import { useEffect, useRef, useState } from "preact/compat";
import { IconDownload, IconRefresh, IconX } from "@tabler/icons-preact";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";
import type { BannerMount } from "../hooks/usePanelInset.ts";
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
 * The element goes to the app through `onMount` so its layout can
 * measure this strip while it is on screen (see usePanelInset). */
export function UpdateBanner(
  { update, onMount }: {
    update: UpdateControls;
    /** The strip's element while it is shown, `null` while it is not. */
    onMount?: BannerMount;
  },
) {
  const t = useT();
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
  const readyText = t("chrome.update.ready", {
    version: status?.latestVersion ?? "",
  });
  const restartText = status?.restartMode === "supervisor"
    ? t("chrome.update.restartNote") + t("chrome.update.systemdNote")
    : canRestart
    ? t("chrome.update.restartNote")
    : t("chrome.update.nextStart");
  const text = restartPending
    ? t("chrome.update.downloaded", { version: status?.appliedVersion ?? "" }) +
      restartText
    : server
    ? readyText
    : readyText + t("chrome.update.installRestart");

  return (
    <div className="update-banner" ref={onMount}>
      {restartPending ? <IconRefresh size={16} /> : <IconDownload size={16} />}
      <span className="update-banner-text">{text}</span>
      {restartPending
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
