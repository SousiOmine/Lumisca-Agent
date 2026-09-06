import { useEffect, useMemo, useRef, useState } from "preact/compat";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconSettings,
} from "@tabler/icons-preact";
import { formatModelMeta } from "@lumisca/core/shared";
import type { ModelInfo, ThinkingLevel } from "../types.ts";
import { filterByQuery, useProviderModels } from "../providers.ts";
import { ThinkingLevelSlider } from "./ThinkingLevelSlider.tsx";

export interface ModelPickerProps {
  value: { provider: string; modelId: string } | null;
  /** Only show models the user enabled in settings. Default true. */
  enabledOnly?: boolean;
  /** Only show models that accept image input. Used by the image-analysis
   * model picker, where a text-only model would be useless. */
  imageOnly?: boolean;
  /** Peer owning the session ("" = this server). When set, the provider
   * and model lists come from that peer, so remote sessions switch models
   * against the machine that runs the agent. */
  peerId?: string;
  /** Called with the selected model; the ModelInfo lets the caller know
   * the model's thinking levels without another fetch. */
  onSelect: (
    provider: string,
    modelId: string,
    info?: ModelInfo,
  ) => void;
  /** Open the provider settings (the "設定画面" link). */
  onOpenSettings?: () => void;
  /** Stored thinking level of the current model, shown in the third
   * (thinking-strength) pane. Takes precedence over the catalog entry so
   * the slider stays in sync right after a change, before any refetch. */
  thinkingValue?: ThinkingLevel;
  /** Supported levels of the current model. Used when its catalog entry
   * is missing (list still loading, credentials removed). */
  thinkingLevels?: ThinkingLevel[];
  /** Persist a thinking-level change for the current model. Omit to
   * render the third pane without a slider (empty margin). */
  onThinkingChange?: (level: ThinkingLevel) => void;
  thinkingDisabled?: boolean;
}

/** Cascading three-panel model picker: providers on the left, models in
 * the middle, thinking strength on the right. Only providers with
 * configured credentials are offered. The third pane keeps a fixed width
 * even for models without thinking support (empty margin then), so the
 * popover never changes size when switching models. */
export function ModelPicker({
  value,
  enabledOnly = true,
  imageOnly = false,
  peerId = "",
  onSelect,
  onOpenSettings,
  thinkingValue,
  thinkingLevels,
  onThinkingChange,
  thinkingDisabled,
}: ModelPickerProps) {
  const { providers: fetchedProviders, modelsByProvider, loading, error } =
    useProviderModels(peerId);
  const [providerId, setProviderId] = useState(value?.provider ?? "");
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Providers the user can actually pick: configured ones only, plus the
  // current provider (even when its credentials were removed, the selected
  // model must stay visible/selectable).
  const providers = useMemo(() => {
    const configured = fetchedProviders.filter((p) => p.configured !== false);
    const current = value?.provider;
    if (current && !configured.some((p) => p.id === current)) {
      return [...configured, {
        id: current,
        name: fetchedProviders.find((p) => p.id === current)?.name ?? current,
      }];
    }
    return configured;
  }, [fetchedProviders, value?.provider]);

  // Preselect the current provider, or the first configured one once the
  // list arrives.
  useEffect(() => {
    if (!providerId && providers.length > 0) {
      setProviderId(providers[0]!.id);
    }
  }, [providers, providerId]);

  // Follow an external provider change (a model switch elsewhere).
  const externalProvider = useRef(value?.provider ?? null);
  useEffect(() => {
    const next = value?.provider ?? null;
    if (next !== null && next !== externalProvider.current) {
      externalProvider.current = next;
      setProviderId(next);
    }
  }, [value?.provider]);

  const models = modelsByProvider.get(providerId) ?? [];

  const visible = useMemo(() => {
    let list = enabledOnly ? models.filter((m) => m.enabled !== false) : models;
    if (imageOnly) list = list.filter((m) => m.input?.includes("image"));
    return filterByQuery(list, search);
  }, [models, search, enabledOnly, imageOnly]);

  // The actively displayed provider: hovered > selected
  const activeProvider = hoveredProvider ?? providerId;

  // Thinking-strength pane: always bound to the committed current model
  // (never to the hovered preview), so a slider gesture only ever edits
  // the model the session actually runs on. The catalog entry wins for
  // the level list; the explicit props cover "catalog not loaded yet".
  const currentInfo = value
    ? modelsByProvider.get(value.provider)?.find((m) => m.id === value.modelId)
    : undefined;
  const resolvedLevels = currentInfo?.thinkingLevels ?? thinkingLevels ?? [];
  const resolvedValue = thinkingValue ?? currentInfo?.thinkingLevel ?? "off";
  const showThinkingSlider = onThinkingChange !== undefined &&
    resolvedLevels.length > 1;

  return (
    <div className="model-picker">
      {error !== null
        ? (
          <div className="error-text">
            {error.phase === "providers"
              ? "プロバイダー一覧を取得できませんでした(サーバーに接続できません)"
              : "モデル一覧を取得できませんでした"}
          </div>
        )
        : providers.length === 0
        ? (
          <div className="settings-note" style={{ padding: 6 }}>
            設定済みのプロバイダーがありません。
            設定画面からAPIキーを登録してください。
          </div>
        )
        : (
          <>
            {/* Left column: providers */}
            <div className="mp-providers">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`mp-provider${
                    activeProvider === p.id ? " active" : ""
                  }`}
                  onClick={() => setProviderId(p.id)}
                  onMouseEnter={() => setHoveredProvider(p.id)}
                  onMouseLeave={() => setHoveredProvider(null)}
                >
                  <span className="mp-provider-name">{p.name}</span>
                  {activeProvider === p.id && (
                    <IconCheck size={14} className="mp-check" />
                  )}
                  <IconChevronRight size={14} className="mp-chevron" />
                </button>
              ))}
              <div className="mp-sep" />
              <button
                type="button"
                className="mp-manage"
                onClick={onOpenSettings}
              >
                <IconSettings size={14} />
                <span>設定画面</span>
              </button>
            </div>

            {/* Middle column: models */}
            <div className="mp-models">
              <input
                className="mp-model-search"
                placeholder="モデルを検索..."
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
              {loading && <div className="mp-loading">読み込み中...</div>}
              <div className="mp-model-list">
                {visible.slice(0, 200).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`mp-model${
                      value?.modelId === m.id ? " selected" : ""
                    }`}
                    onClick={() => onSelect(providerId, m.id, m)}
                  >
                    <span className="mp-model-id">{m.id}</span>
                    <span className="mp-model-meta">
                      {formatModelMeta(m.contextWindow)}
                      {m.reasoning && (
                        <IconBrain
                          size={12}
                          title="思考モデル"
                          aria-label="思考モデル"
                        />
                      )}
                    </span>
                    {value?.modelId === m.id && (
                      <IconCheck size={14} className="mp-check" />
                    )}
                  </button>
                ))}
                {visible.length === 0 && !loading && (
                  <div className="mp-empty">
                    {imageOnly && models.length > 0
                      ? "画像対応モデルがありません"
                      : enabledOnly && models.length > 0
                      ? "有効なモデルがありません(設定でモデルを有効にしてください)"
                      : "該当するモデルがありません"}
                  </div>
                )}
              </div>
            </div>

            {
              /* Far-right column: thinking strength (fixed width; for
                models without levels it stays a borderless empty
                margin, so the popover size never shifts while
                switching models). */
            }
            <div className={`mp-thinking${showThinkingSlider ? "" : " empty"}`}>
              {showThinkingSlider
                ? (
                  <>
                    <div className="mp-thinking-head">思考強度</div>
                    <ThinkingLevelSlider
                      value={resolvedValue}
                      levels={resolvedLevels}
                      onCommit={onThinkingChange!}
                      disabled={thinkingDisabled}
                    />
                  </>
                )
                : <div className="mp-thinking-empty" aria-hidden="true" />}
            </div>
          </>
        )}
    </div>
  );
}
