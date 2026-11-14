import { LOCALES } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import type { Locale, ThemeSetting } from "../../types.ts";
import { Select } from "../Select.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { THEME_OPTIONS } from "../settings/AppearancePanel.tsx";
import { LANGUAGE_OPTION_KEYS } from "../settings/GeneralPanel.tsx";

export interface WelcomeStepProps {
  theme: ThemeSetting;
  /** Persist failure of the last theme choice (the control already rolled
   * back, so this only explains why). */
  themeError: string | null;
  onThemeChange: (theme: ThemeSetting) => void;
  language: Locale;
  languageError: string | null;
  onLanguageChange: (language: Locale) => void;
}

/**
 * Step 1: the greeting, and the two choices that change how the rest of the
 * wizard itself looks.
 *
 * The language is asked first for that reason: the remaining steps, and every
 * conversation after them, read in it. Both values are the settings dialog's
 * own preferences (the option lists and the catalogue keys are the panels'),
 * so a choice made here is the same choice, not a copy of it.
 */
export function WelcomeStep({
  theme,
  themeError,
  onThemeChange,
  language,
  languageError,
  onLanguageChange,
}: WelcomeStepProps) {
  const t = useT();
  return (
    <>
      <h2 className="setup-step-title">{t("setup.welcome.title")}</h2>
      <div className="settings-list">
        <SettingRow label={t("settings.language.label")}>
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
        <SettingRow label={t("settings.appearance.theme.label")}>
          <Select
            label={t("settings.appearance.theme.label")}
            value={theme}
            options={THEME_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={onThemeChange}
          />
        </SettingRow>
      </div>
      {languageError && (
        <p className="error-text" role="alert">
          {t("settings.language.saveFailed", { error: languageError })}
        </p>
      )}
      {themeError && (
        <p className="error-text" role="alert">
          {t("settings.appearance.saveFailed", { error: themeError })}
        </p>
      )}
    </>
  );
}
