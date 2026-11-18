import { LOCALES } from "@lumisca/core/shared";
import type {
  UpdateFailureKind,
  UpdateSource,
} from "../../hooks/useUpdateStatus.ts";
import { useT } from "../../i18n.ts";
import type { UpdateStatus } from "../../shell.ts";
import type { Locale } from "../../types.ts";
import { Select } from "../Select.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { LANGUAGE_OPTION_KEYS } from "./language-options.ts";
import { UpdateSection } from "./UpdateSection.tsx";

interface OverviewPanelProps {
  status: UpdateStatus | null;
  source: UpdateSource | null;
  bridgeError: string | null;
  failure: UpdateFailureKind | null;
  language: Locale;
  languageError: string | null;
  onLanguageChange: (language: Locale) => void;
  onSetAuto: (enabled: boolean) => void;
  onSetAutoRestart: (enabled: boolean) => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRestart: () => void;
}

/**
 * Settings → 概要: which server this page is served by, what it runs, and the
 * one value that reaches both the server and the screen.
 *
 * The address is not decoration. An installed app cannot show its own
 * address, and "the updater is unavailable" is otherwise indistinguishable
 * from "you are looking at a different installation than you think". The
 * language is here because the server reads it when a session starts; the
 * sentence under the row says that it also changes the screen, which is the
 * coupling this page has to admit rather than hide.
 *
 * The updater is the server's own. When the desktop shell answers instead,
 * the app owns the running program and the update lives on the device's app
 * page; this page says so rather than drawing a toggle over a program it
 * cannot update.
 */
export function OverviewPanel({
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
}: OverviewPanelProps) {
  const t = useT();
  const host = globalThis.location?.host ?? "";

  return (
    <div className="settings-pane">
      {host !== "" && (
        <div className="update-item">
          <div className="update-info">
            <span className="update-label">
              {t("settings.general.serverAddress")}
            </span>
            <span className="update-desc">{host}</span>
          </div>
        </div>
      )}

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
      {languageError && (
        <p className="error-text" role="alert">
          {t("settings.language.saveFailed", { error: languageError })}
        </p>
      )}

      {source === "shell" ? (
        <p className="settings-note">{t("settings.overview.managedByApp")}</p>
      ) : (
        <UpdateSection
          status={status}
          source={source}
          bridgeError={bridgeError}
          failure={failure}
          onSetAuto={onSetAuto}
          onSetAutoRestart={onSetAutoRestart}
          onCheck={onCheck}
          onDownload={onDownload}
          onInstall={onInstall}
          onRestart={onRestart}
        />
      )}
    </div>
  );
}
