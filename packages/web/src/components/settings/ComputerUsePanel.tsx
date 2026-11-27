import { COMPUTER_USE_ENABLED_KEY, errorMessage } from "@lumisca/core/shared";
import { useEffect, useState } from "preact/hooks";
import { useSaveAction } from "../../hooks/useSave.ts";
import { useT } from "../../i18n.ts";
import { settingsStore, useSettings } from "../../settingsStore.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** Settings → 画面の操作: computer use — the agent captures this machine's
 * screen and drives its mouse and keyboard. The feature is opt-in, because
 * a run can then click and type anywhere on the machine.
 *
 * Its own page, and code mode's alone: the flag decides which tools code
 * mode's sessions are offered, while a stella conversation works on its own
 * machine and never reads it. The page is drawn only while code mode is
 * offered (SettingsModal's `codeModeOnly`), so a reader who does not run
 * code mode never meets a switch that changes nothing.
 *
 * The flag decides which tools a session is offered, so the server
 * brings the open sessions onto it: an idle one is rebuilt, and a running
 * one keeps its run and has the tools reseeded in place (the new tools are
 * found through tool_search from the next turn on). A server whose
 * environment cannot offer the feature answers 503 and its message is shown
 * here like any other failure. */
export function ComputerUsePanel() {
  const t = useT();
  // The flag lives in the shared settings store (read once for the page).
  const settings = useSettings();
  const loaded = settings.loaded;
  const [enabled, setEnabled] = useState(false);
  const { saving, error, save } = useSaveAction(errorMessage);

  useEffect(() => {
    if (!loaded) return;
    setEnabled(settings.values[COMPUTER_USE_ENABLED_KEY] === "1");
  }, [loaded, settings.values]);

  const setEnabledValue = (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic
    void save(
      () => settingsStore.set(COMPUTER_USE_ENABLED_KEY, next ? "1" : ""),
      () => setEnabled(previous),
    );
  };

  return (
    <SettingsSection>
      <SettingRow
        label={t("settings.computerUse.title")}
        description={
          loaded ? t("settings.computerUse.description") : t("common.loading")
        }
      >
        <Toggle
          checked={enabled}
          disabled={saving || !loaded}
          onChange={setEnabledValue}
          label={t("settings.computerUse.title")}
        />
      </SettingRow>

      {error && (
        <div className="error-text">
          {t("settings.computerUse.operationFailed", { error })}
        </div>
      )}
    </SettingsSection>
  );
}
