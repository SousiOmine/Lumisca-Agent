import {
  createPortal,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/compat";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  parseModelPreference,
  serializeModelPreference,
} from "@lumisca/core/shared";
import type { ModelPreference, ThinkingLevel } from "@lumisca/core/shared";
import { useClickOutside } from "../../hooks/useClickOutside.ts";
import { usePopoverPlacement } from "../../hooks/usePopoverPlacement.ts";
import { settingsStore, useSettings } from "../../settingsStore.ts";
import { useT } from "../../i18n.ts";
import { thinkingLevelLabel } from "../../format.ts";
import {
  errorText,
  setModelThinkingLevel,
  useProviderModels,
} from "../../providers.ts";
import { ModelPicker } from "../ModelPicker.tsx";

interface ModelPrefRow {
  key: string;
  label: string;
  description: string;
  /** Restrict the picker to models that accept image input. */
  imageOnly?: boolean;
  /** Show the model's stored thinking level (used by the sub-agents that
   * run on this model). */
  thinking?: boolean;
}

/** Settings → モデル: the auxiliary model preferences (fast model, image
 * analysis model). Configured here in the settings dialog, separate from
 * the per-session model chosen in the chatbox picker. The fast model runs
 * the sub-agents (the task tool) and generates session titles; its
 * thinking level is the sub-agents' reasoning level. */
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
  const popoverRef = useRef<HTMLDivElement>(null);
  // Model catalog of this server (settings are always local); the fast
  // model's thinking level is derived from it below.
  const { modelsByProvider, reload: reloadModels } = useProviderModels();

  // Localized ROWS, built inside the component so t() is available.
  const localizedRows = useMemo<ModelPrefRow[]>(() => [
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

  // Close on outside click, Escape and window blur. A scroll does not close it:
  // the placement follows the trigger while the settings content scrolls
  // (hooks/usePopoverPlacement.ts), so closing on scroll would undo that.
  useClickOutside(popoverRef, () => setOpenRow(null), openRow !== null, {
    onBlur: true,
    within: anchor,
  });

  /** Where the open row's picker goes: measured against the button that opened
   * it (hooks/usePopoverPlacement.ts) and limited to the room that is there, so
   * a window too short for the popover shrinks it instead of pushing half of
   * it off the screen. Re-measured on resize, which also re-decides whether
   * the three panes fit. */
  const placement = usePopoverPlacement(anchor, openRow !== null, "below");

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
      // Keep the picker open after a model pick so the thinking pane can
      // be tuned for the new model in the same opening (it closes on
      // outside click / Escape / scroll). Clearing from the row button
      // never has the popover open, so nothing changes there.
      // A picked model brings its own levels: refresh the catalog (a
      // fresh fetch also covers a provider configured during this
      // session).
      reloadModels();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(null);
    }
  };

  const openRowDef = localizedRows.find((r) => r.key === openRow);

  return (
    <div className="settings-pane model-pref-panel">
      {localizedRows.map((row) => {
        const value = values[row.key];
        return (
          <div key={row.key} className="model-pref-item">
            <div className="model-pref-info">
              <span className="model-pref-label">{row.label}</span>
              <span className="model-pref-desc">{row.description}</span>
            </div>
            <div className="model-pref-value">
              {!loaded && !loadError
                ? (
                  <span className="model-pref-unset">
                    {t("common.loading")}
                  </span>
                )
                : value
                ? (
                  <>
                    <span className="mono">
                      {value.provider}/{value.modelId}
                    </span>
                    {row.thinking && levelsByRow[row.key] && (
                      <span className="model-pref-level">
                        {thinkingLevelLabel(levelsByRow[row.key]!.current, t)}
                      </span>
                    )}
                  </>
                )
                : (
                  <span className="model-pref-unset">
                    {t("settings.model.unset")}
                  </span>
                )}
            </div>
            <div className="model-pref-actions">
              <button
                type="button"
                className="btn small"
                disabled={saving === row.key}
                onClick={(e) => openPicker(row.key, e.currentTarget)}
              >
                {t("settings.personalize.update")}
              </button>
              {value && (
                <button
                  type="button"
                  className="btn small"
                  disabled={saving === row.key}
                  onClick={() => save(row.key, undefined)}
                >
                  {t("common.cancel")}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {
        /* Portaled to the body: the settings modal clips overflowing
          descendants (overflow: hidden), which would cut off the wide
          three-pane picker. The measured placement keeps it inside the
          viewport (z-index sits above the modal backdrop). */
      }
      {openRow !== null && openRowDef && placement !== null && createPortal(
        <div
          className="mp-popover model-pref-popover"
          style={placement.style}
          ref={popoverRef}
        >
          <ModelPicker
            value={values[openRow] ?? null}
            imageOnly={openRowDef.imageOnly}
            stacked={!placement.panes}
            roomHeight={placement.height}
            onClose={() => setOpenRow(null)}
            onSelect={(provider, modelId) =>
              save(openRow, { provider, modelId })}
            onOpenSettings={() => {
              setOpenRow(null);
              onOpenProviders();
            }}
            thinkingValue={openRowDef.thinking
              ? levelsByRow[openRow]?.current
              : undefined}
            thinkingLevels={openRowDef.thinking
              ? levelsByRow[openRow]?.supported
              : undefined}
            onThinkingChange={openRowDef.thinking
              ? (level) => void changeLevel(values[openRow], level)
              : undefined}
            thinkingDisabled={savingLevel || saving !== null}
          />
        </div>,
        document.body,
      )}

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
    </div>
  );
}
