import {
  APP_UI_IN_SYSTEM_PROMPT_KEY,
  ASK_TOOL_ENABLED_KEY,
  appUiInSystemPrompt,
  askToolEnabled,
  CODE_EXECUTION_ENABLED_KEY,
  errorMessage,
} from "@lumisca/core/shared";
import { useEffect, useState } from "preact/compat";
import { setCodeModeEnabled, useCodeModeEnabled } from "../../codeMode.ts";
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
 * The tool and prompt switches change what the agent is built from, so the
 * server rebuilds the open sessions when one moves: a session that is
 * waiting follows at once, and one in the middle of a run follows when that
 * run ends. The run already sent its tools and prompt, and replacing the
 * agent under it would duplicate the rows of the turn in flight. The comment
 * on `setCodeExecutionEnabled` in core.ts is the same rule; the ask and
 * app-UI switches follow it too.
 *
 * The code mode switch is the exception: it changes what the app OFFERS (the
 * menu's switch, the addresses that are screens), not how an agent is built,
 * so no session is rebuilt and the client applies it at once
 * (packages/web/src/codeMode.ts).
 *
 * The saved-prompt list is not here: it is a page of its own, drawn only while
 * code mode is offered (see SettingsModal). */
export function ExperimentalPanel() {
  const t = useT();
  const settings = useSettings();
  const loaded = settings.loaded;
  const [codeExecution, setCodeExecution] = useState(false);
  // The switch says "disable" while the stored key says "enabled": the
  // inversion stays here, and the value written is always "1" or "0".
  const [askDisabled, setAskDisabled] = useState(false);
  const [appUiInPrompt, setAppUiInPrompt] = useState(false);
  // Code mode's switch is not read from the dialog's settings snapshot: the
  // answer has to exist before the first render (a bookmarked `/code` is
  // redirected on the way), so the server sends it with the page and this
  // store keeps it current (codeMode.ts).
  const codeMode = useCodeModeEnabled();
  const codeSave = useSaveAction(errorMessage);
  const codeModeSave = useSaveAction(errorMessage);
  const askSave = useSaveAction(errorMessage);
  const appUiSave = useSaveAction(errorMessage);

  useEffect(() => {
    if (!loaded) return;
    setCodeExecution(settings.values[CODE_EXECUTION_ENABLED_KEY] === "1");
    setAskDisabled(!askToolEnabled((key) => settings.values[key]));
    setAppUiInPrompt(appUiInSystemPrompt((key) => settings.values[key]));
  }, [loaded, settings.values]);

  const setCodeModeValue = (next: boolean) => {
    // Optimistic inside setCodeModeEnabled: the switch moves now, and a
    // rejected write restores it (the error line below says why).
    void codeModeSave.save(() => setCodeModeEnabled(next));
  };

  const setCodeExecutionValue = (next: boolean) => {
    const previous = codeExecution;
    setCodeExecution(next); // optimistic
    void codeSave.save(
      () => settingsStore.set(CODE_EXECUTION_ENABLED_KEY, next ? "1" : ""),
      () => setCodeExecution(previous),
    );
  };

  const setAskDisabledValue = (next: boolean) => {
    const previous = askDisabled;
    setAskDisabled(next); // optimistic
    void askSave.save(
      () => settingsStore.set(ASK_TOOL_ENABLED_KEY, next ? "0" : "1"),
      () => setAskDisabled(previous),
    );
  };

  const setAppUiInPromptValue = (next: boolean) => {
    const previous = appUiInPrompt;
    setAppUiInPrompt(next); // optimistic
    void appUiSave.save(
      () => settingsStore.set(APP_UI_IN_SYSTEM_PROMPT_KEY, next ? "1" : ""),
      () => setAppUiInPrompt(previous),
    );
  };

  return (
    <>
      <SettingsSection>
        <SettingRow
          label={t("settings.experimental.codeMode.title")}
          description={t("settings.experimental.codeMode.description")}
        >
          <Toggle
            checked={codeMode}
            disabled={codeModeSave.saving || !loaded}
            onChange={setCodeModeValue}
            label={t("settings.experimental.codeMode.title")}
          />
        </SettingRow>

        {codeModeSave.error && (
          <div className="error-text">
            {t("settings.experimental.codeMode.operationFailed", {
              error: codeModeSave.error,
            })}
          </div>
        )}

        <SettingRow
          label={t("settings.experimental.codeExecution.title")}
          description={
            loaded
              ? t("settings.experimental.codeExecution.description")
              : t("common.loading")
          }
        >
          <Toggle
            checked={codeExecution}
            disabled={codeSave.saving || !loaded}
            onChange={setCodeExecutionValue}
            label={t("settings.experimental.codeExecution.title")}
          />
        </SettingRow>

        {codeSave.error && (
          <div className="error-text">
            {t("settings.experimental.codeExecution.operationFailed", {
              error: codeSave.error,
            })}
          </div>
        )}

        <SettingRow label={t("settings.experimental.askTool.title")}>
          <Toggle
            checked={askDisabled}
            disabled={askSave.saving || !loaded}
            onChange={setAskDisabledValue}
            label={t("settings.experimental.askTool.title")}
          />
        </SettingRow>

        {askSave.error && (
          <div className="error-text">
            {t("settings.experimental.askTool.operationFailed", {
              error: askSave.error,
            })}
          </div>
        )}

        <SettingRow
          label={t("settings.experimental.appUiPrompt.title")}
          description={t("settings.experimental.appUiPrompt.description")}
        >
          <Toggle
            checked={appUiInPrompt}
            disabled={appUiSave.saving || !loaded}
            onChange={setAppUiInPromptValue}
            label={t("settings.experimental.appUiPrompt.title")}
          />
        </SettingRow>

        {appUiSave.error && (
          <div className="error-text">
            {t("settings.experimental.appUiPrompt.operationFailed", {
              error: appUiSave.error,
            })}
          </div>
        )}
      </SettingsSection>
    </>
  );
}
