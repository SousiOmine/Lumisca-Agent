import { DEFAULT_MODEL_KEY, parseModelPreference } from "@lumisca/core/shared";
import { useT } from "../../i18n.ts";
import { useProviderModels } from "../../providers.ts";
import { useSetting } from "../../settingsStore.ts";
import { SettingRow } from "../SettingRow.tsx";

/**
 * Step 4: what the wizard decided, and the way in.
 *
 * A summary rather than another form: the reader has just answered these, and
 * the point of showing them again is to name what the app will start with
 * (and to make a skipped provider visible as skipped). Nothing here is
 * editable — the settings dialog is the place for a change, and the footer's
 * はじめる is the only action.
 */
export function DoneStep() {
  const t = useT();
  const { providers } = useProviderModels("");
  const stored = useSetting(DEFAULT_MODEL_KEY);
  const model = parseModelPreference(stored);

  // "Connected" is the app's own definition (a credential stored inside
  // Lumisca, see the provider routes): a key that only exists in the shell's
  // environment is not counted, and saying so is honest about what the
  // settings dialog would show.
  const connected = providers.filter(
    (provider) => provider.configured === true,
  ).length;

  return (
    <>
      <h2 className="setup-step-title">{t("setup.done.title")}</h2>
      <div className="settings-list">
        <SettingRow label={t("settings.nav.providers")}>
          <span className="setup-summary">
            {connected > 0
              ? t("setup.done.providersConnected", { count: connected })
              : t("setup.done.providersNone")}
          </span>
        </SettingRow>
        <SettingRow label={t("settings.model.defaultModel")}>
          <span className="setup-summary mono">
            {model !== undefined
              ? `${model.provider}/${model.modelId}`
              : t("settings.model.unset")}
          </span>
        </SettingRow>
      </div>
    </>
  );
}
