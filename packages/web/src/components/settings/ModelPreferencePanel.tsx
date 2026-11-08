import { useEffect, useMemo, useRef, useState } from "preact/compat";
import { IconChevronDown } from "@tabler/icons-preact";
import {
  DEFAULT_MODEL_KEY,
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  parseModelPreference,
  serializeModelPreference,
} from "@lumisca/core/shared";
import type { ModelPreference, ThinkingLevel } from "@lumisca/core/shared";
import { settingsStore, useSettings } from "../../settingsStore.ts";
import { useT } from "../../i18n.ts";
import {
  errorText,
  setModelThinkingLevel,
  useProviderModels,
} from "../../providers.ts";
import { ModelPickerPopover } from "../ModelPickerPopover.tsx";
import { ThinkingLevelSelect } from "../ThinkingLevelSelect.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

interface ModelPrefRow {
  key: string;
  label: string;
  description: string;
  /** Restrict the picker to models that accept image input. */
  imageOnly?: boolean;
  /** Offer the model's thinking-strength slider in the picker. */
  thinking?: boolean;
}

/** Settings → モデル: the stored model preferences. Configured here in the
 * settings dialog, separate from the per-session model chosen in the
 * chatbox picker. The default model starts new conversations; the fast
 * model runs the sub-agents (the task tool) and generates session titles.
 * Each row's thinking level is the stored per-model reasoning level. */
export function ModelPreferencePanel(
  { onOpenProviders }: { onOpenProviders: () => void },
) {
  const t = useT();
  const [values, setValues] = useState<
    Record<string, ModelPreference | undefined>
  >({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [openRow, setOpenRow] = useState<string | null>(null);
  /** The button that opened the picker: the popover is placed against it. */
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | undefined>();
  /** Optimistic thinking levels committed through the slider, keyed by
   * `provider/modelId`. The catalog copy goes stale after a commit until
   * the next refetch, so this keeps the row readout and the picker pane
   * in sync right away (keyed by model, a later model switch naturally
   * misses it). */
  const [levelOverrides, setLevelOverrides] = useState<
    Record<string, ThinkingLevel>
  >({});
  const [savingLevel, setSavingLevel] = useState(false);
  // Model catalog of this server (settings are always local); each row's
  // thinking level is derived from it below.
  const { modelsByProvider, reload: reloadModels } = useProviderModels();

  // Localized ROWS, built inside the component so t() is available.
  const localizedRows = useMemo<ModelPrefRow[]>(() => [
    {
      key: DEFAULT_MODEL_KEY,
      label: t("settings.model.defaultModel"),
      description: t("settings.model.defaultModelDesc"),
      thinking: true,
    },
    {
      key: FAST_MODEL_KEY,
      label: t("settings.model.fastModel"),
      description: t("settings.model.fastModelDesc"),
      thinking: true,
    },
    {
      key: IMAGE_MODEL_KEY,
      label: t("settings.model.imageAnalysisModel"),
      description: t("settings.model.imageAnalysisModelDesc"),
      imageOnly: true,
      thinking: true,
    },
  ], [t]);

  /** Load the stored preferences once, from the shared settings store. */
  const settingsState = useSettings();
  useEffect(() => {
    if (!settingsState.loaded || settingsState.error !== null) return;
    setValues({
      [DEFAULT_MODEL_KEY]: parseModelPreference(
        settingsState.values[DEFAULT_MODEL_KEY],
      ),
      [FAST_MODEL_KEY]: parseModelPreference(
        settingsState.values[FAST_MODEL_KEY],
      ),
      [IMAGE_MODEL_KEY]: parseModelPreference(
        settingsState.values[IMAGE_MODEL_KEY],
      ),
    });
    setLoaded(true);
  }, [settingsState.loaded, settingsState.error, settingsState.values]);
  useEffect(() => {
    if (settingsState.error !== null) setLoadError(settingsState.error);
  }, [settingsState.error]);

  /** The stored + supported thinking levels of every thinking-capable
   * row, derived from the model catalog once its provider's models
   * arrive (undefined when the model is unset, gone, or has no levels).
   * Committed-but-not-yet-refetched levels win via `levelOverrides`. */
  const levelsByRow = useMemo(() => {
    const out: Record<
      string,
      { current: ThinkingLevel; supported: ThinkingLevel[] } | undefined
    > = {};
    for (const row of localizedRows) {
      if (!row.thinking) continue;
      const pref = values[row.key];
      if (pref === undefined) continue;
      const model = modelsByProvider.get(pref.provider)?.find(
        (m) => m.id === pref.modelId,
      );
      const supported = model?.thinkingLevels ?? [];
      out[row.key] = supported.length <= 1 ? undefined : {
        current: levelOverrides[`${pref.provider}/${pref.modelId}`] ??
          model?.thinkingLevel ?? "off",
        supported,
      };
    }
    return out;
  }, [modelsByProvider, values, levelOverrides, localizedRows]);

  /** Open a row's picker; the same row's button closes it again (the button is
   * itself inside the popover's click-outside area, so the toggle has to live
   * here). */
  const openPicker = (rowKey: string, button: HTMLButtonElement) => {
    anchor.current = button;
    setOpenRow((current) => (current === rowKey ? null : rowKey));
  };

  /** Persist a row model's thinking level (the reasoning level the
   * model runs on). Applies the server-confirmed level optimistically
   * and refreshes the catalog for eventual consistency. */
  const changeLevel = async (
    pref: ModelPreference | undefined,
    level: ThinkingLevel,
  ) => {
    if (pref === undefined) return;
    setSavingLevel(true);
    try {
      const thinkingLevel = await setModelThinkingLevel(
        "",
        pref.provider,
        pref.modelId,
        level,
      );
      setLevelOverrides((prev) => ({
        ...prev,
        [`${pref.provider}/${pref.modelId}`]: thinkingLevel,
      }));
      reloadModels();
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSavingLevel(false);
    }
  };

  const save = async (rowKey: string, pref: ModelPreference | undefined) => {
    setSaving(rowKey);
    setSaveError(undefined);
    try {
      await settingsStore.set(
        rowKey,
        pref ? serializeModelPreference(pref) : "",
      );
      setValues((prev) => ({ ...prev, [rowKey]: pref }));
      // A picked model brings its own levels: refresh the catalog (a fresh
      // fetch also covers a provider configured during this session). The
      // row's thinking select follows that catalog, so the levels it offers
      // must be the ones of the model that was just saved.
      reloadModels();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(null);
    }
  };

  const openRowDef = localizedRows.find((r) => r.key === openRow);

  return (
    <SettingsSection>
      {localizedRows.map((row) => {
        const value = values[row.key];
        return (
          <div key={row.key} className="model-pref-item">
            <div className="model-pref-info">
              <span className="model-pref-label">{row.label}</span>
              <span className="model-pref-desc">{row.description}</span>
            </div>
            {
              /* The pair IS the control: it reads as the row's value and
              opens the picker, so the row needs no separate edit button. */
            }
            <button
              type="button"
              className={`model-pref-picker${
                openRow === row.key ? " open" : ""
              }`}
              aria-label={t("settings.model.changeNamed", { name: row.label })}
              disabled={saving === row.key}
              onClick={(e) => openPicker(row.key, e.currentTarget)}
            >
              {!loaded && !loadError
                ? (
                  <span className="model-pref-unset">
                    {t("common.loading")}
                  </span>
                )
                : value
                ? (
                  <span className="mono">
                    {value.provider}/{value.modelId}
                  </span>
                )
                : (
                  <span className="model-pref-unset">
                    {t("settings.model.unset")}
                  </span>
                )}
              <span className={`chevron${openRow === row.key ? " open" : ""}`}>
                <IconChevronDown size={14} />
              </span>
            </button>
            {row.thinking && levelsByRow[row.key] && (
              <ThinkingLevelSelect
                value={levelsByRow[row.key]!.current}
                levels={levelsByRow[row.key]!.supported}
                onChange={(level) => void changeLevel(value, level)}
                disabled={savingLevel || saving !== null}
              />
            )}
            {value && (
              <button
                type="button"
                className="btn small model-pref-clear"
                disabled={saving === row.key}
                onClick={() => save(row.key, undefined)}
              >
                {t("settings.model.clear")}
              </button>
            )}
          </div>
        );
      })}

      <ModelPickerPopover
        anchor={anchor}
        open={openRow !== null && openRowDef !== undefined}
        value={openRow === null ? null : values[openRow] ?? null}
        imageOnly={openRowDef?.imageOnly}
        onClose={() => setOpenRow(null)}
        onSelect={(provider, modelId) => {
          if (openRow === null) return;
          void save(openRow, { provider, modelId });
        }}
        onOpenSettings={() => {
          setOpenRow(null);
          onOpenProviders();
        }}
      />

      {loadError && (
        <div className="error-text">
          {t("settings.model.loadFailed", { error: loadError })}
        </div>
      )}
      {saveError && (
        <div className="error-text">
          {t("settings.model.saveFailed", { error: saveError })}
        </div>
      )}
    </SettingsSection>
  );
}
