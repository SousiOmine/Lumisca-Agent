import { useEffect, useRef, useState } from "react";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  parseModelPreference,
  serializeModelPreference,
  THINKING_LEVEL_LABELS,
} from "@lumisca/core/shared";
import type { ModelPreference, ThinkingLevel } from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { useClickOutside } from "../../hooks/useClickOutside.ts";
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

const ROWS: ModelPrefRow[] = [
  {
    key: FAST_MODEL_KEY,
    label: "高速モデル",
    description:
      "エージェント本体とは別に、高速で安価な補助処理（サブエージェントの実行など）に使うモデル。",
    thinking: true,
  },
  {
    key: IMAGE_MODEL_KEY,
    label: "画像分析モデル",
    description:
      "画像認識に対応していないモデルの代わりに、画像の解釈を担当するモデル。",
    imageOnly: true,
  },
];

const MENU_MARGIN = 8;

/** Settings → モデル: the auxiliary model preferences (fast model, image
 * analysis model). Configured here in the settings dialog, separate from
 * the per-session model chosen in the chatbox picker. The fast model runs
 * the sub-agents (the task tool) and generates session titles; its
 * thinking level is the sub-agents' reasoning level. */
export function ModelPreferencePanel() {
  const [values, setValues] = useState<
    Record<string, ModelPreference | undefined>
  >({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | undefined>();
  /** Stored thinking level of the fast model (the one sub-agents run on),
   * loaded from the model catalog. */
  const [levels, setLevels] = useState<
    { current: ThinkingLevel; supported: ThinkingLevel[] } | undefined
  >();
  const [savingLevel, setSavingLevel] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({});
  // Model catalog of this server (settings are always local); the fast
  // model's thinking level is derived from it below.
  const { modelsByProvider, reload: reloadModels } = useProviderModels();

  /** Load the stored preferences once. */
  useEffect(() => {
    let stale = false;
    api.getSettings()
      .then((settings) => {
        if (stale) return;
        setValues({
          [FAST_MODEL_KEY]: parseModelPreference(settings[FAST_MODEL_KEY]),
          [IMAGE_MODEL_KEY]: parseModelPreference(settings[IMAGE_MODEL_KEY]),
        });
        setLoaded(true);
      })
      .catch((e) => {
        if (!stale) setLoadError(errorText(e));
      });
    return () => {
      stale = true;
    };
  }, []);

  /** The stored + supported thinking levels of the fast model, derived
   * from the model catalog once its provider's models arrive (undefined
   * when the model is unset, gone, or has no levels). */
  const fastPref = values[FAST_MODEL_KEY];
  useEffect(() => {
    if (fastPref === undefined) {
      setLevels(undefined);
      return;
    }
    const models = modelsByProvider.get(fastPref.provider);
    if (models === undefined) return; // provider's models not loaded yet
    const model = models.find((m) => m.id === fastPref.modelId);
    if (model === undefined) {
      setLevels(undefined);
      return;
    }
    const supported = model.thinkingLevels ?? [];
    setLevels(
      supported.length <= 1
        ? undefined
        : { current: model.thinkingLevel ?? "off", supported },
    );
  }, [modelsByProvider, fastPref]);

  // Close on outside click, Escape, scroll and window blur (the settings
  // content scrolls independently of the fixed-position popover).
  useClickOutside(popoverRef, () => setOpenRow(null), openRow !== null, {
    onScroll: true,
    onBlur: true,
  });

  // Clamp the popover position to the viewport once it renders.
  useEffect(() => {
    if (openRow === null) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos((prev) => ({
      x: Math.max(
        MENU_MARGIN,
        Math.min(prev.x, globalThis.innerWidth - rect.width - MENU_MARGIN),
      ),
      y: Math.max(
        MENU_MARGIN,
        Math.min(prev.y, globalThis.innerHeight - rect.height - MENU_MARGIN),
      ),
    }));
  }, [openRow]);

  const openPicker = (rowKey: string, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setPos({ x: rect.left, y: rect.bottom + 6 });
    setOpenRow(rowKey);
  };

  const save = async (rowKey: string, pref: ModelPreference | undefined) => {
    setSaving(rowKey);
    setSaveError(undefined);
    try {
      await api.setSetting(rowKey, pref ? serializeModelPreference(pref) : "");
      setValues((prev) => ({ ...prev, [rowKey]: pref }));
      setOpenRow(null);
      // The fast model's thinking level follows the model: refresh the
      // catalog (the level effect above re-derives it; a fresh fetch also
      // covers a provider configured during this session).
      if (rowKey === FAST_MODEL_KEY) {
        reloadModels();
      }
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(null);
    }
  };

  const openRowDef = ROWS.find((r) => r.key === openRow);

  return (
    <div className="settings-pane model-pref-panel">
      <p className="settings-note">
        エージェントで使うモデルとは別に、補助的な用途のモデルを設定します
        (チャット欄のモデル選択には影響しません)。
      </p>

      {ROWS.map((row) => {
        const value = values[row.key];
        return (
          <div key={row.key} className="model-pref-item">
            <div className="model-pref-info">
              <span className="model-pref-label">{row.label}</span>
              <span className="model-pref-desc">{row.description}</span>
            </div>
            <div className="model-pref-value">
              {!loaded && !loadError
                ? <span className="model-pref-unset">読み込み中...</span>
                : value
                ? (
                  <>
                    <span className="mono">
                      {value.provider}/{value.modelId}
                    </span>
                    {row.thinking && levels && (
                      <label className="model-pref-level" title="思考強度">
                        <select
                          value={levels.current}
                          disabled={savingLevel}
                          onChange={async (e) => {
                            const level = e.target.value as ThinkingLevel;
                            setSavingLevel(true);
                            try {
                              const thinkingLevel = await setModelThinkingLevel(
                                "",
                                value.provider,
                                value.modelId,
                                level,
                              );
                              setLevels((prev) =>
                                prev === undefined
                                  ? prev
                                  : { ...prev, current: thinkingLevel }
                              );
                            } catch (err) {
                              setSaveError(errorText(err));
                            } finally {
                              setSavingLevel(false);
                            }
                          }}
                        >
                          {levels.supported.map((level) => (
                            <option key={level} value={level}>
                              {THINKING_LEVEL_LABELS[level]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                )
                : <span className="model-pref-unset">未設定</span>}
            </div>
            <div className="model-pref-actions">
              <button
                type="button"
                className="btn small"
                ref={(el) => {
                  anchors.current[row.key] = el;
                }}
                disabled={saving === row.key}
                onClick={(e) => openPicker(row.key, e.currentTarget)}
              >
                変更
              </button>
              {value && (
                <button
                  type="button"
                  className="btn small"
                  disabled={saving === row.key}
                  onClick={() => save(row.key, undefined)}
                >
                  クリア
                </button>
              )}
            </div>
          </div>
        );
      })}

      {openRow !== null && openRowDef && (
        <div
          className="model-pref-popover"
          style={{ left: pos.x, top: pos.y }}
          ref={popoverRef}
        >
          <ModelPicker
            value={values[openRow] ?? null}
            imageOnly={openRowDef.imageOnly}
            onSelect={(provider, modelId) =>
              save(openRow, { provider, modelId })}
            onOpenSettings={() => setOpenRow(null)}
          />
        </div>
      )}

      {loadError && (
        <div className="error-text">
          設定の読み込みに失敗しました: {loadError}
        </div>
      )}
      {saveError && (
        <div className="error-text">保存に失敗しました: {saveError}</div>
      )}
    </div>
  );
}
