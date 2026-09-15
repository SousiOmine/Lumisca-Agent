import type { ThemeSetting } from "../../types.ts";
import type { MessageKey } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";

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
      <div className="appearance-item">
        <span className="appearance-label">
          {t("settings.appearance.theme.label")}
        </span>
        <select
          value={theme}
          onChange={(e) => onThemeChange(e.currentTarget.value as ThemeSetting)}
          aria-label={t("settings.appearance.theme.label")}
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {t("settings.appearance.saveFailed", { error })}
        </p>
      )}
    </div>
  );
}
