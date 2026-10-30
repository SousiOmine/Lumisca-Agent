import { useEffect, useState } from "preact/compat";
import { COMPUTER_USE_ENABLED_KEY } from "@lumisca/core/shared";
import { errorText } from "../../providers.ts";
import { useSaveAction } from "../../hooks/useSave.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { settingsStore, useSettings } from "../../settingsStore.ts";
import { useT } from "../../i18n.ts";

/** Settings → セキュリティ: computer use — the agent captures this machine's
 * screen and drives its mouse and keyboard. The feature is opt-in, because
 * a run can then click and type anywhere on the machine.
 *
 * The flag decides which tools a session is given, so the server rebuilds
 * the open sessions when it changes: a change while a session runs is
 * refused (409) and the toggle rolls back to the stored value. A server whose
 * environment cannot offer the feature answers 503 and its message is shown
 * here like any other failure. */
export function ComputerUsePanel() {
  const t = useT();
  // The flag lives in the shared settings store (read once for the page).
  const settings = useSettings();
  const loaded = settings.loaded;
  const [enabled, setEnabled] = useState(false);
  const { saving, error, save } = useSaveAction(errorText);

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
    <div className="settings-pane">
      <SettingRow
        label={t("settings.computerUse.title")}
        description={loaded
          ? t("settings.computerUse.description")
          : t("common.loading")}
        title={t("settings.computerUse.tooltip")}
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
    </div>
  );
}
