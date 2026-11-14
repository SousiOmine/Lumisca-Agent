import { DEFAULT_MODEL_KEY, parseModelPreference } from "@lumisca/core/shared";
import { IconChevronDown } from "@tabler/icons-preact";
import { useRef, useState } from "preact/compat";
import { rememberDefaultModel } from "../../defaultModel.ts";
import { useT } from "../../i18n.ts";
import { errorText, useProviderModels } from "../../providers.ts";
import { useSetting } from "../../settingsStore.ts";
import { ModelPickerPopover } from "../ModelPickerPopover.tsx";
import { SettingRow } from "../SettingRow.tsx";

/**
 * Step 3: the model a new conversation starts on.
 *
 * The value is the settings dialog's `model_default` (written through
 * `rememberDefaultModel`, the same call the new-session screen's picker
 * makes), so the two screens cannot disagree. Leaving it unset is a real
 * answer: the server then resolves a model from the connected providers, and
 * the note under the row says so.
 *
 * Without a connected provider there is nothing to list, and the step says
 * that instead of opening an empty picker.
 */
export function ModelStep() {
  const t = useT();
  const { providers, loading } = useProviderModels("");
  const stored = useSetting(DEFAULT_MODEL_KEY);
  const value = parseModelPreference(stored);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const connected = providers.some(
    (provider) => provider.configured !== false || provider.userDefined,
  );

  const choose = (provider: string, modelId: string) => {
    setOpen(false);
    setError(undefined);
    // Persisted in the background, like every preference: the row keeps the
    // picked value through the settings store, and a failed write is said
    // rather than silently leaving the old model in place.
    void rememberDefaultModel(provider, modelId).catch((failure) =>
      setError(errorText(failure)),
    );
  };

  return (
    <>
      <h2 className="setup-step-title">{t("setup.model.title")}</h2>
      {connected ? (
        <>
          <SettingRow label={t("settings.model.defaultModel")}>
            <button
              type="button"
              ref={anchor}
              className={`model-pref-picker${open ? " open" : ""}`}
              aria-label={t("settings.model.changeNamed", {
                name: t("settings.model.defaultModel"),
              })}
              onClick={() => setOpen((current) => !current)}
            >
              {value !== undefined ? (
                <span className="mono">
                  {value.provider}/{value.modelId}
                </span>
              ) : (
                <span className="model-pref-unset">
                  {t("settings.model.unset")}
                </span>
              )}
              <span className={`chevron${open ? " open" : ""}`}>
                <IconChevronDown size={14} />
              </span>
            </button>
          </SettingRow>
          <p className="settings-note">{t("setup.model.auto")}</p>
        </>
      ) : (
        <p className="settings-note">
          {loading ? t("common.loading") : t("setup.model.none")}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {t("common.saveFailed", { error })}
        </p>
      )}
      <ModelPickerPopover
        anchor={anchor}
        open={open}
        value={value ?? null}
        onSelect={choose}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
