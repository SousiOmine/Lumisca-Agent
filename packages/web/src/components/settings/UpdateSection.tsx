import { formatBytes } from "@lumisca/core/shared";
import type { ReactNode } from "preact/compat";
import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import { useT } from "../../i18n.ts";
import type { UpdateStatus } from "../../shell.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";

interface UpdateSectionProps {
  /** null = no updater reachable (a browser against a development server). */
  status: UpdateStatus | null;
  /** Which updater answered ("shell" = the desktop app the user launched,
   * "server" = the standalone server hosting this page). */
  source: UpdateSource | null;
  /** Last bridge/API failure, if any (the status may be stale). */
  bridgeError: string | null;
  /** Why the server's updater could not be read, when that is what failed. */
  failure: UpdateFailureKind | null;
  onSetAuto: (enabled: boolean) => void;
  onSetAutoRestart: (enabled: boolean) => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRestart: () => void;
}

/**
 * The updater of one program: the desktop app or the server.
 *
 * The same status shape answers for both, and the two used to share a page.
 * That page was the clearest case of the settings dialog's missing owner: the
 * toggle it showed wrote to whichever program had answered, so the same row
 * changed the app on a desktop launch and the server on a browser visit. The
 * owner is now the page around this section: the device's app page or the
 * server's overview, never both.
 *
 * The section itself is one object at the top of the page: the version, the
 * check beside it, what the check found, and the controls that decide how an
 * update is applied. Splitting those across a page made an available update
 * read apart from the number it replaces.
 */
export function UpdateSection({
  status,
  source,
  bridgeError,
  failure,
  onSetAuto,
  onSetAutoRestart,
  onCheck,
  onDownload,
  onInstall,
  onRestart,
}: UpdateSectionProps) {
  const t = useT();
  const server = source === "server";

  // Why there are no controls. Each reason is a different problem with a
  // different answer, so the section says which one it is instead of one
  // sentence for all of them; before a first answer arrives it says that it
  // is asking, rather than claiming there is no updater.
  const unavailableNote =
    failure === "no-updater"
      ? t("settings.general.updateNoUpdater")
      : failure === "unauthorized"
        ? t("settings.general.updateUnauthorized")
        : failure === "unreachable"
          ? t("settings.general.updateUnreachable")
          : failure === "failed"
            ? t("settings.general.updateReadFailed", {
                error: bridgeError ?? "",
              })
            : bridgeError === null
              ? t("settings.general.checkingUpdate")
              : t("settings.general.shellUnreachable") + bridgeError;

  if (status === null) {
    return <p className="settings-note">{unavailableNote}</p>;
  }

  const supported = status.supported !== false;
  const percent =
    status.progress == null ? null : Math.round(status.progress * 100);
  const restartPending = server && status.restartPending === true;
  const canRestart = restartPending && status.restartMode !== "none";
  // Replacing the files takes seconds and moves nothing else in the status:
  // without this the section looks frozen after the install click.
  const installing = status.installing === true;
  // A check is asked for by the version row; the updater answers one request
  // at a time, so the button is out while one is already in flight.
  const checkDisabled = status.checking || status.downloading || installing;
  const statusText = status.checking
    ? t("settings.general.checkingUpdate")
    : installing
      ? t("settings.general.installing")
      : restartPending
        ? canRestart
          ? status.restartMode === "supervisor"
            ? t("settings.general.appliedRestartSystemd", {
                version: status.appliedVersion,
              })
            : t("settings.general.appliedRestartDesktop", {
                version: status.appliedVersion,
              })
          : t("settings.general.appliedNextStart", {
              version: status.appliedVersion,
            })
        : status.ready
          ? server
            ? t("settings.general.readyToInstallServer", {
                version: status.latestVersion,
              })
            : t("settings.general.readyToInstall", {
                version: status.latestVersion,
              })
          : status.available
            ? t("settings.general.versionAvailable", {
                version: status.latestVersion,
              })
            : t("settings.general.latestVersion");

  // The one file action the status offers. A staged package that is being
  // installed is already moving, and the check for another release is beside
  // the version instead.
  let action: ReactNode = null;
  if (!installing) {
    if (restartPending) {
      action = canRestart ? (
        <button type="button" className="btn push" onClick={onRestart}>
          {t("settings.general.restart")}
        </button>
      ) : null;
    } else if (status.ready) {
      action = (
        <button type="button" className="btn push" onClick={onInstall}>
          {t("settings.general.install")}
        </button>
      );
    } else if (status.available) {
      action = (
        <button type="button" className="btn push" onClick={onDownload}>
          {t("settings.general.download")}
        </button>
      );
    }
  }

  // The line under the version: what the last check found, and the one file
  // action it offers.
  const stateLine = status.downloading ? (
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
        {t("settings.general.downloading")}{" "}
        {formatBytes(status.downloaded ?? 0, "MB")}
        {status.total ? ` / ${formatBytes(status.total, "MB")}` : ""}
      </span>
      {percent !== null && <span className="update-percent">{percent}%</span>}
    </>
  ) : (
    <>
      <span className="update-status-text">{statusText}</span>
      {/* Installing has nothing to press, and the check for another release
          is above, beside the version. */}
      <div className="update-actions">{action}</div>
    </>
  );

  return (
    <>
      {/* The version, the check for another one, and what that check found:
          one object at the right edge, so an available update is read with
          the number it replaces instead of a row further down the page. */}
      <div className="update-item">
        <div className="update-info">
          <span className="update-label">
            {server
              ? t("settings.general.serverInfo")
              : t("settings.general.appInfo")}
          </span>
          <span className="update-desc">Lumisca</span>
        </div>
        <div className="update-app">
          <div className="update-version">
            <span className="mono">v{status.currentVersion}</span>
            {/* Beside the version, in every state: a package staged by an
                earlier release must not be a dead end (a failed install keeps
                its package, and only a check learns that a newer release
                replaced it). */}
            {supported && (
              <button
                type="button"
                className="btn small"
                disabled={checkDisabled}
                onClick={onCheck}
              >
                {t("settings.general.checkForUpdate")}
              </button>
            )}
          </div>
          {supported && <div className="update-state">{stateLine}</div>}
        </div>
      </div>

      {status.ready && !installing && (
        <p className="settings-note">
          {server
            ? t("settings.general.installNoteServer")
            : t("settings.general.installNote")}
        </p>
      )}
      {restartPending && status.restartMode === "none" && (
        <p className="settings-note">
          {t("settings.general.autoRestartDisabled")}
        </p>
      )}

      {supported && (
        <>
          <SettingRow label={t("settings.general.autoUpdate")}>
            <Toggle
              checked={status.autoUpdate}
              onChange={onSetAuto}
              label={t("settings.general.autoUpdate")}
            />
          </SettingRow>

          {server && (
            <SettingRow
              label={t("settings.general.autoRestart")}
              description={t("settings.general.autoRestartDesc")}
            >
              <Toggle
                checked={status.autoRestart === true}
                disabled={status.restartMode === "none"}
                onChange={onSetAutoRestart}
                label={t("settings.general.autoRestart")}
              />
            </SettingRow>
          )}
        </>
      )}

      {!supported && (
        <p className="settings-note">
          {t("settings.general.autoUpdateNotAvailable")}
          {status.unsupportedReason ? `: ${status.unsupportedReason}` : "。"}
        </p>
      )}

      {status.error && <div className="error-text">{status.error}</div>}
      {/* A shell failure and a server failure are different sentences: the
          bridge's "cannot communicate with the desktop shell" would be
          wrong here, where the server itself is what did not answer. */}
      {bridgeError !== null && failure === null && (
        <div className="error-text" role="alert">
          {t("settings.general.shellUnreachable")}
          {bridgeError}
        </div>
      )}
      {failure !== null && (
        <div className="error-text" role="alert">
          {unavailableNote}
        </div>
      )}
    </>
  );
}
