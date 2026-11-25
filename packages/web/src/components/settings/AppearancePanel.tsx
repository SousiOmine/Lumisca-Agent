import type { MessageKey } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import {
  type SendShortcut,
  setSendShortcut,
  useSendShortcut,
} from "../../sendShortcut.ts";
import type { ThemeSetting } from "../../types.ts";
import { Select } from "../Select.tsx";
import { SettingRow } from "../SettingRow.tsx";

interface AppearancePanelProps {
  theme: ThemeSetting;
  onThemeChange: (theme: ThemeSetting) => void;
}

/** The option labels are catalogue keys: the panel reads in the app
 * language, and the values stay the stored setting's vocabulary. Also read by
 * the first-run setup, which asks the same question (see
 * components/setup/WelcomeStep.tsx). */
export const THEME_OPTIONS: { value: ThemeSetting; label: MessageKey }[] = [
  { value: "light", label: "settings.appearance.theme.light" },
  { value: "dark", label: "settings.appearance.theme.dark" },
  { value: "system", label: "settings.appearance.theme.system" },
];

const SEND_SHORTCUT_OPTIONS: { value: SendShortcut; label: MessageKey }[] = [
  { value: "mod-enter", label: "settings.appearance.sendShortcut.modEnter" },
  { value: "enter", label: "settings.appearance.sendShortcut.enter" },
];

/** The theme row of Settings → アプリ. Theme is applied to <html data-theme>
 * immediately and stored in this client's own storage, so it survives reloads
 * and does not follow the reader to another device. It shares the app page
 * because both answer for the client in front of the reader; it had a page of
 * its own while a category per preference looked like a system. The app
 * language has its own panel (LanguagePanel) on the server's side: it
 * additionally decides what new sessions answer in, so the server holds it. */
export function AppearancePanel({
  theme,
  onThemeChange,
}: AppearancePanelProps) {
  const t = useT();
  const sendShortcut = useSendShortcut();
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
      <SettingRow label={t("settings.appearance.sendShortcut.label")}>
        <Select
          label={t("settings.appearance.sendShortcut.label")}
          value={sendShortcut}
          options={SEND_SHORTCUT_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setSendShortcut}
        />
      </SettingRow>
    </div>
  );
}
