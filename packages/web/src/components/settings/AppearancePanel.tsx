import type { ThemeSetting } from "../../types.ts";

interface AppearancePanelProps {
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => void;
}

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "システム" },
];

/** Settings → 外観. Theme is applied to <html data-theme> immediately and
 * persisted to the server settings, so it survives reloads. */
export function AppearancePanel(
  { theme, onThemeChange }: AppearancePanelProps,
) {
  return (
    <div className="settings-pane">
      <p className="settings-note">アプリの配色を設定します。</p>
      <div className="appearance-item">
        <span className="appearance-label">テーマ</span>
        <select
          value={theme}
          onChange={(e) => onThemeChange(e.target.value as ThemeSetting)}
          aria-label="テーマ"
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
