import type { ThemeSetting } from "../../types.ts";

interface AppearancePanelProps {
  theme: ThemeSetting;
  /** Persist failure of the theme setting; the select already rolled back
   * to the stored value, so this only explains why. */
  error: string | null;
  onThemeChange: (theme: ThemeSetting) => void;
}

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "システム設定に連動" },
];

/** Settings → 外観. Theme is applied to <html data-theme> immediately and
 * persisted to the server settings, so it survives reloads. */
export function AppearancePanel(
  { theme, error, onThemeChange }: AppearancePanelProps,
) {
  return (
    <div className="settings-pane">
      <div className="appearance-item">
        <span className="appearance-label">テーマ設定</span>
        <select
          value={theme}
          onChange={(e) => onThemeChange(e.currentTarget.value as ThemeSetting)}
          aria-label="テーマ設定"
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="error-text" role="alert">
          テーマ設定を保存できませんでした: {error}
        </p>
      )}
    </div>
  );
}
