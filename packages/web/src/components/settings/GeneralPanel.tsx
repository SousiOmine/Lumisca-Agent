import type { UpdateStatus } from "../../shell.ts";
import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import type { PushControls } from "../../hooks/usePush.ts";
import { LOCALES, type MessageKey } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { Select } from "../Select.tsx";
import type { Locale } from "../../types.ts";

interface GeneralPanelProps {
  /** null = no updater reachable (a browser against a development server). */
  status: UpdateStatus | null;
  /** Which updater answered ("shell" = the desktop app the user launched,
   * "server" = the standalone server hosting this page). */
  source: UpdateSource | null;
  /** Last bridge/API failure, if any (the status may be stale). */
  bridgeError: string | null;
  /** Why the server's updater could not be read, when that is what failed. */
  failure: UpdateFailureKind | null;
  /** The app language and the persist failure of the last change. */
  language: Locale;
  languageError: string | null;
  onLanguageChange: (language: Locale) => void;
  onSetAuto: (enabled: boolean) => void;
  onSetAutoRestart: (enabled: boolean) => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRestart: () => void;
  /** Background agent-event notifications (desktop only). */
  notifyEnabled: boolean;
  onNotifyEnabledChange: (enabled: boolean) => void;
  /** PWA notifications of the same events (Web Push), for this device. */
  push: PushControls;
}

/** Selector labels in each language's own name where it differs: a reader
 * looking for their language finds it without knowing the current one. */
const LANGUAGE_OPTION_KEYS: Record<Locale, MessageKey> = {
  ja: "settings.language.option.ja",
  en: "settings.language.option.en",
};

/** The app language, a general preference like the notification toggle.
 * The choice applies to the UI immediately and to the system prompt of
 * sessions created after it (the server reads the same setting); sessions
 * already started keep the language they began in. */
function LanguageItem(
  { language, error, onLanguageChange }: {
    language: Locale;
    error: string | null;
    onLanguageChange: (language: Locale) => void;
  },
) {
  const t = useT();
  return (
    <>
      <SettingRow
        label={t("settings.language.label")}
        description={t("settings.language.description")}
      >
        <Select
          label={t("settings.language.label")}
          value={language}
          options={LOCALES.map((locale) => ({
            value: locale,
            label: t(LANGUAGE_OPTION_KEYS[locale]),
          }))}
          onChange={onLanguageChange}
        />
      </SettingRow>
      {error && (
        <p className="error-text" role="alert">
          {t("settings.language.saveFailed", { error })}
        </p>
      )}
    </>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** The same events, delivered to an installed PWA through the browser's push
 * service. A separate row from the desktop toggle because it is a separate
 * channel to a separate device: the desktop shell notifies the window the app
 * runs in, this one notifies every phone and laptop the app was installed on.
 *
 * The row disappears where the channel cannot exist (an insecure origin, the
 * desktop shell's loopback page, a browser without the Push API) and says why
 * where it exists but was refused. */
function PushNotificationsItem({ push }: { push: PushControls }) {
  const t = useT();
  if (push.state === "unsupported") {
    return (
      <SettingRow label={t("settings.general.pushNotifications")}>
        <span className="update-desc">
          {t("settings.general.pushUnsupported")}
        </span>
      </SettingRow>
    );
  }
  return (
    <>
      <SettingRow
        label={t("settings.general.pushNotifications")}
        description={t("settings.general.pushNotificationsDesc")}
      >
        <Toggle
          checked={push.state === "on"}
          disabled={push.state === "busy" || push.state === "denied"}
          onChange={push.toggle}
          label={t("settings.general.pushNotifications")}
        />
      </SettingRow>
      {push.state === "denied" && (
        <p className="settings-note" role="alert">
          {t("settings.general.pushDenied")}
        </p>
      )}
      {push.state === "on" && (
        <div className="update-status-row">
          <span className="update-status-text">
            {push.tested ? t("settings.general.pushTestSent") : ""}
          </span>
          <div className="update-actions">
            <button type="button" className="btn small" onClick={push.sendTest}>
              {t("settings.general.pushTest")}
            </button>
          </div>
        </div>
      )}
      {push.error !== null && (
        <p className="error-text" role="alert">
          {t("settings.general.pushFailed", { error: push.error })}
        </p>
      )}
    </>
  );
}

/** Settings → General: the app preferences (language, notifications) and
 * the auto-update controls.
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
    failure,
    language,
    languageError,
    onLanguageChange,
    onSetAuto,
    onSetAutoRestart,
    onCheck,
    onDownload,
    onInstall,
    onRestart,
    notifyEnabled,
    onNotifyEnabledChange,
    push,
  }: GeneralPanelProps,
) {
  const t = useT();

  // The language and the notification toggle are app preferences of their
  // own: they are shown whether or not an updater answered.
  const languageItem = (
    <LanguageItem
      language={language}
      error={languageError}
      onLanguageChange={onLanguageChange}
    />
  );

  // Which server this page is talking to. An installed app cannot show its
  // address, and "the update is unavailable" is otherwise indistinguishable
  // from "you are looking at a different installation than you think".
  const host = globalThis.location?.host ?? "";
  const addressItem = host === "" ? null : (
    <div className="update-item">
      <div className="update-info">
        <span className="update-label">
          {t("settings.general.serverAddress")}
        </span>
        <span className="update-desc">{host}</span>
      </div>
    </div>
  );

  // Why there are no controls. Each reason is a different problem with a
  // different answer, so the panel says which one it is instead of one
  // sentence for all of them; before a first answer arrives it says that it
  // is asking, rather than claiming there is no updater.
  const unavailableNote = failure === "no-updater"
    ? t("settings.general.updateNoUpdater")
    : failure === "unauthorized"
    ? t("settings.general.updateUnauthorized")
    : failure === "unreachable"
    ? t("settings.general.updateUnreachable")
    : failure === "failed"
    ? t("settings.general.updateReadFailed", { error: bridgeError ?? "" })
    : bridgeError === null
    ? t("settings.general.checkingUpdate")
    : t("settings.general.shellUnreachable") + bridgeError;

  if (status === null) {
    return (
      <div className="settings-pane">
        {languageItem}
        {addressItem}
        <p className="settings-note">{unavailableNote}</p>
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
  // Replacing the files takes seconds and moves nothing else in the status:
  // without this the panel looks frozen after the install click.
  const installing = status.installing === true;
  const statusText = status.checking
    ? t("settings.general.checkingUpdate")
    : installing
    ? t("settings.general.installing")
    : restartPending
    ? (canRestart
      ? status.restartMode === "supervisor"
        ? t("settings.general.appliedRestartSystemd", {
          version: status.appliedVersion,
        })
        : t("settings.general.appliedRestartDesktop", {
          version: status.appliedVersion,
        })
      : t("settings.general.appliedNextStart", {
        version: status.appliedVersion,
      }))
    : status.ready
    ? (server
      ? t("settings.general.readyToInstallServer", {
        version: status.latestVersion,
      })
      : t("settings.general.readyToInstall", { version: status.latestVersion }))
    : status.available
    ? t("settings.general.versionAvailable", { version: status.latestVersion })
    : t("settings.general.latestVersion");

  return (
    <div className="settings-pane">
      {languageItem}

      <div className="update-item">
        <div className="update-info">
          <span className="update-label">
            {server
              ? t("settings.general.serverInfo")
              : t("settings.general.appInfo")}
          </span>
          <span className="update-desc">Lumisca</span>
        </div>
        <span className="mono">v{status.currentVersion}</span>
      </div>

      {addressItem}

      {supported && (
        <>
          <SettingRow
            label={t("settings.general.autoUpdate")}
            description={server
              ? t("settings.general.autoUpdateDescServer")
              : t("settings.general.autoUpdateDesc")}
          >
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
                    {t("settings.general.downloading")}{" "}
                    {formatBytes(status.downloaded)}
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
                          {t("settings.general.checkForUpdate")}
                        </button>
                      )
                      : installing
                      ? (
                        <button type="button" className="btn push" disabled>
                          {t("settings.general.installing")}
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
                            {t("settings.general.restart")}
                          </button>
                        )
                        : null
                      : status.ready
                      ? (
                        <>
                          <button
                            type="button"
                            className="btn push"
                            onClick={onInstall}
                          >
                            {t("settings.general.install")}
                          </button>
                          {
                            /* The staged package is the *previous* release
                              when a newer one is out (a failed install keeps
                              its package staged), so checking must stay
                              reachable — otherwise the screen offers a
                              package that cannot be installed and no way to
                              learn that a new release exists. */
                          }
                          <button
                            type="button"
                            className="btn small"
                            onClick={onCheck}
                          >
                            {t("settings.general.checkForUpdate")}
                          </button>
                        </>
                      )
                      : status.available
                      ? (
                        <button
                          type="button"
                          className="btn push"
                          onClick={onDownload}
                        >
                          {t("settings.general.download")}
                        </button>
                      )
                      : (
                        <button
                          type="button"
                          className="btn small"
                          onClick={onCheck}
                        >
                          {t("settings.general.checkForUpdate")}
                        </button>
                      )}
                  </div>
                </>
              )}
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
        </>
      )}

      {!supported && (
        <p className="settings-note">
          {t("settings.general.autoUpdateNotAvailable")}
          {status.unsupportedReason ? `: ${status.unsupportedReason}` : "。"}
        </p>
      )}

      {status.error && <div className="error-text">{status.error}</div>}
      {
        /* A shell failure and a server failure are different sentences: the
          bridge's "cannot communicate with the desktop shell" would be
          wrong here, where the server itself is what did not answer. */
      }
      {bridgeError !== null && failure === null && (
        <div className="error-text" role="alert">
          {t("settings.general.shellUnreachable")}
          {bridgeError}
        </div>
      )}
      {failure !== null && (
        <div className="error-text" role="alert">{unavailableNote}</div>
      )}

      {source === "shell" && (
        <SettingRow label={t("settings.general.bgNotification")}>
          <Toggle
            checked={notifyEnabled}
            onChange={onNotifyEnabledChange}
            label={t("settings.general.bgNotification")}
          />
        </SettingRow>
      )}

      <PushNotificationsItem push={push} />
    </div>
  );
}
