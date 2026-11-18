import { CODE_EXECUTION_ENABLED_KEY, errorMessage } from "@lumisca/core/shared";
import { useEffect, useState } from "preact/compat";
import { useSaveAction } from "../../hooks/useSave.ts";
import { useT } from "../../i18n.ts";
import { settingsStore, useSettings } from "../../settingsStore.ts";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** Settings → 実験的機能: features under test, each one a switch.
 *
 * The page exists so a change that is still being judged does not sit among
 * the settings a reader can rely on. Everything here is install-wide, like
 * the rest of the dialog, and the note at its top says what that means for
 * a feature on it: it may change or disappear.
 *
 * Code execution replaces the tools the model is given, so the server
 * rebuilds the open sessions when the switch moves: a session that is
 * waiting follows at once, and one in the middle of a run follows when that
 * run ends. The run already sent its tool set, and replacing the agent under
 * it would duplicate the rows of the turn in flight. The comment on
 * `setCodeExecutionEnabled` in core.ts is the same rule. */
export function ExperimentalPanel() {
  const t = useT();
  const settings = useSettings();
  const loaded = settings.loaded;
  const [enabled, setEnabled] = useState(false);
  const { saving, error, save } = useSaveAction(errorMessage);

  useEffect(() => {
    if (!loaded) return;
    setEnabled(settings.values[CODE_EXECUTION_ENABLED_KEY] === "1");
  }, [loaded, settings.values]);

  const setEnabledValue = (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic
    void save(
      () => settingsStore.set(CODE_EXECUTION_ENABLED_KEY, next ? "1" : ""),
      () => setEnabled(previous),
    );
  };

  return (
    <SettingsSection description={t("settings.experimental.description")}>
      <SettingRow
        label={t("settings.experimental.codeExecution.title")}
        description={
          loaded
            ? t("settings.experimental.codeExecution.description")
            : t("common.loading")
        }
        title={t("settings.experimental.codeExecution.tooltip")}
      >
        <Toggle
          checked={enabled}
          disabled={saving || !loaded}
          onChange={setEnabledValue}
          label={t("settings.experimental.codeExecution.title")}
        />
      </SettingRow>

      {error && (
        <div className="error-text">
          {t("settings.experimental.codeExecution.operationFailed", { error })}
        </div>
      )}
    </SettingsSection>
  );
}
