import type { ThemeSetting } from "../../types.ts";
import type { MessageKey } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import { SettingRow } from "../SettingRow.tsx";
import { Select } from "../Select.tsx";

interface AppearancePanelProps {
  theme: ThemeSetting;
  /** Persist failure of the theme setting; the select already rolled back
   * to the stored value, so this only explains why. */
  error: string | null;
  onThemeChange: (theme: ThemeSetting) => void;
}

/** The option labels are catalogue keys: the panel reads in the app
 * language, and the values stay the stored setting's vocabulary. */
const THEME_OPTIONS: { value: ThemeSetting; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.theme.light" },
  { value: "dark", label: "settings.appearance.theme.dark" },
  { value: "system", label: "settings.appearance.theme.system" },
];

/** Settings → 外観. Theme is applied to <html data-theme> immediately and
 * persisted to the server settings, so it survives reloads. The app
 * language has its own panel (LanguagePanel): it is a separate concern and
 * additionally decides what new sessions answer in. */
export function AppearancePanel(
  { theme, error, onThemeChange }: AppearancePanelProps,
) {
  const t = useT();
  return (
    <div className="settings-pane">
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
      {error && (
        <p className="error-text" role="alert">
          {t("settings.appearance.saveFailed", { error })}
        </p>
      )}
    </div>
  );
}
