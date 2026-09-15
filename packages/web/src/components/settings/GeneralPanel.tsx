import type { UpdateStatus } from "../../shell.ts";
import type { UpdateSource } from "../../hooks/useUpdateStatus.ts";
import { LOCALES, type MessageKey } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import type { Locale } from "../../types.ts";

interface GeneralPanelProps {
  /** null = no updater reachable (a browser against a development server). */
  status: UpdateStatus | null;
  /** Which updater answered ("shell" = the desktop app the user launched,
   * "server" = the standalone server hosting this page). */
  source: UpdateSource | null;
  /** Last bridge/API failure, if any (the status may be stale). */
  bridgeError: string | null;
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
 * already started keep the language they began in, so the row says so. */
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
      <div className="update-item">
        <div className="update-info">
          <span className="update-label">{t("settings.language.label")}</span>
          <span className="update-desc">
            {t("settings.language.description")}
          </span>
        </div>
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.currentTarget.value as Locale)}
          aria-label={t("settings.language.label")}
        >
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {t(LANGUAGE_OPTION_KEYS[locale])}
            </option>
          ))}
        </select>
      </div>
      <p className="settings-note">{t("settings.language.note")}</p>
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

  if (status === null) {
    return (
      <div className="settings-pane">
        {languageItem}
        <p className="settings-note">
          {t("settings.general.autoUpdateUnavailable")}
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
    ? t("settings.general.checkingUpdate")
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

      {supported && (
        <>
          <div className="update-item">
            <div className="update-info">
              <span className="update-label">
                {t("settings.general.autoUpdate")}
              </span>
              <span className="update-desc">
                {server
                  ? t("settings.general.autoUpdateDescServer")
                  : t("settings.general.autoUpdateDesc")}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={status.autoUpdate}
                onChange={(e) => onSetAuto(e.currentTarget.checked)}
                aria-label={t("settings.general.autoUpdate")}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {server && (
            <div className="update-item">
              <div className="update-info">
                <span className="update-label">
                  {t("settings.general.autoRestart")}
                </span>
                <span className="update-desc">
                  {t("settings.general.autoRestartDesc")}
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={status.autoRestart === true}
                  disabled={status.restartMode === "none"}
                  onChange={(e) => onSetAutoRestart(e.currentTarget.checked)}
                  aria-label={t("settings.general.autoRestart")}
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
                        <button
                          type="button"
                          className="btn push"
                          onClick={onInstall}
                        >
                          {t("settings.general.install")}
                        </button>
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

          {status.ready && (
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
      {bridgeError && (
        <div className="error-text" role="alert">
          {t("settings.general.shellUnreachable")}
          {bridgeError}
        </div>
      )}

      {source === "shell" && (
        <div className="update-item">
          <div className="update-info">
            <span className="update-label">
              {t("settings.general.bgNotification")}
            </span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={notifyEnabled}
              onChange={(e) => onNotifyEnabledChange(e.currentTarget.checked)}
              aria-label={t("settings.general.bgNotification")}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      )}
    </div>
  );
}
