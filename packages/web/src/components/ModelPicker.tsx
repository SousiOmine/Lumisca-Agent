import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconSettings,
} from "@tabler/icons-react";
import { formatModelMeta } from "@lumisca/core/shared";
import type { ModelInfo } from "../types.ts";
import { filterByQuery, useProviderModels } from "../providers.ts";

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
  /** Open the settings modal (for "Manage models" link). */
  onOpenSettings?: () => void;
}

/** Cascading two-panel model picker: providers on the left, models on the right.
 * Only providers with configured credentials are offered. */
export function ModelPicker({
  value,
  enabledOnly = true,
  imageOnly = false,
  peerId = "",
  onSelect,
  onOpenSettings,
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

            {/* Right column: models */}
            <div className="mp-models">
              <input
                className="mp-model-search"
                placeholder="モデルを検索..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
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
          </>
        )}
    </div>
  );
}
