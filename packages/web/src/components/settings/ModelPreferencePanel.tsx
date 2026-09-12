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
import {
  type ModelPreference,
  THINKING_LEVEL_LABELS,
  type ThinkingLevel,
} from "@lumisca/core/shared";
import { api } from "../../api.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
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
      "タスク本体とは別に、高速・低コストな補助処理（要約・サブタスクなど）で使用するモデルです。",
    thinking: true,
  },
  {
    key: IMAGE_MODEL_KEY,
    label: "画像分析モデル",
    description:
      "メインモデルが画像認識に未対応の場合に、代替として画像の解析・読み取りを担当するモデルです。",
    imageOnly: true,
    thinking: true,
  },
];

const MENU_MARGIN = 8;

/** Settings → モデル: the auxiliary model preferences (fast model, image
 * analysis model). Configured here in the settings dialog, separate from
 * the per-session model chosen in the chatbox picker. The fast model runs
 * the sub-agents (the task tool) and generates session titles; its
 * thinking level is the sub-agents' reasoning level. */
export function ModelPreferencePanel(
  { onOpenProviders }: { onOpenProviders: () => void },
) {
  const [values, setValues] = useState<
    Record<string, ModelPreference | undefined>
  >({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
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
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({});
  // Model catalog of this server (settings are always local); the fast
  // model's thinking level is derived from it below.
  const {
    modelsByProvider,
    loading: modelsLoading,
    reload: reloadModels,
  } = useProviderModels();

  /** Load the stored preferences once. */
  useAsyncEffect(async (isStale) => {
    try {
      const settings = await api.getSettings();
      if (isStale()) return;
      setValues({
        [FAST_MODEL_KEY]: parseModelPreference(settings[FAST_MODEL_KEY]),
        [IMAGE_MODEL_KEY]: parseModelPreference(settings[IMAGE_MODEL_KEY]),
      });
      setLoaded(true);
    } catch (e) {
      if (!isStale()) setLoadError(errorText(e));
    }
  }, []);

  /** The stored + supported thinking levels of every thinking-capable
   * row, derived from the model catalog once its provider's models
   * arrive (undefined when the model is unset, gone, or has no levels).
   * Committed-but-not-yet-refetched levels win via `levelOverrides`. */
  const levelsByRow = useMemo(() => {
    const out: Record<
      string,
      { current: ThinkingLevel; supported: ThinkingLevel[] } | undefined
    > = {};
    for (const row of ROWS) {
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
  }, [modelsByProvider, values, levelOverrides]);

  // Close on outside click, Escape, scroll and window blur (the settings
  // content scrolls independently of the fixed-position popover).
  useClickOutside(popoverRef, () => setOpenRow(null), openRow !== null, {
    onScroll: true,
    onBlur: true,
  });

  // Clamp the popover position to the viewport once it renders. Re-run
  // when the catalog arrives: the popover jumps to full width once
  // providers/models render, and a measurement taken while still
  // loading would leave it overflowing.
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
  }, [openRow, modelsLoading]);

  const openPicker = (rowKey: string, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setPos({ x: rect.left, y: rect.bottom + 6 });
    setOpenRow(rowKey);
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
      await api.setSetting(rowKey, pref ? serializeModelPreference(pref) : "");
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

  const openRowDef = ROWS.find((r) => r.key === openRow);

  return (
    <div className="settings-pane model-pref-panel">
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
                ? <span className="model-pref-unset">読み込み中…</span>
                : value
                ? (
                  <>
                    <span className="mono">
                      {value.provider}/{value.modelId}
                    </span>
                    {row.thinking && levelsByRow[row.key] && (
                      <span className="model-pref-level">
                        {THINKING_LEVEL_LABELS[levelsByRow[row.key]!.current]}
                      </span>
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

      {
        /* Portaled to the body: the settings modal clips overflowing
          descendants (overflow: hidden), which would cut off the wide
          three-pane picker. At body level the viewport clamp above keeps
          it fully visible (z-index sits above the modal backdrop). */
      }
      {openRow !== null && openRowDef && createPortal(
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
          設定の読み込みに失敗しました: {loadError}
        </div>
      )}
      {saveError && (
        <div className="error-text">保存に失敗しました: {saveError}</div>
      )}
    </div>
  );
}
