import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { formatModelMeta } from "../format.ts";
import type { ModelInfo } from "../types.ts";

export interface ModelPickerProps {
  value: { provider: string; modelId: string } | null;
  /** Only show models the user enabled in settings. Default true. */
  enabledOnly?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  /** Called with the models of the active provider (for external state). */
  onModelsLoaded?: (models: ModelInfo[]) => void;
}

/** Provider + searchable model selection, shared by modals and the chat bar.
 * Only providers with configured credentials are offered. */
export function ModelPicker({
  value,
  enabledOnly = true,
  onSelect,
  onModelsLoaded,
}: ModelPickerProps) {
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providerId, setProviderId] = useState(value?.provider ?? "");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listProviders().then((ps) => {
      const configured = ps.filter((p) => p.configured !== false);
      setProviders(configured);
      if (!providerId && configured.length > 0) {
        setProviderId(configured[0]!.id);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!providerId) return;
    setBusy(true);
    setModels([]);
    api.listModels(providerId)
      .then((ms) => {
        setModels(ms);
        onModelsLoaded?.(ms);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const visible = useMemo(() => {
    const list = enabledOnly ? models.filter((m) => m.enabled !== false) : models;
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q),
    );
  }, [models, search, enabledOnly]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {providers.length === 0 ? (
        <div className="settings-note" style={{ padding: 6 }}>
          設定済みのプロバイダーがありません。
          設定画面からAPIキーを登録してください。
        </div>
      ) : (
        <>
          <label>
            プロバイダー
            <select
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setSearch("");
              }}
            >
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            モデル{busy && <span style={{ color: "var(--accent)" }}> 読み込み中...</span>}
            <input
              placeholder="モデルを検索..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="model-list">
              {visible.slice(0, 200).map((m) => (
                <div
                  key={m.id}
                  className={`model-item${value?.modelId === m.id ? " selected" : ""}`}
                  onClick={() => onSelect(providerId, m.id)}
                >
                  <span className="model-id">{m.id}</span>
                  <span className="model-meta">
                    {formatModelMeta(m.contextWindow, m.reasoning)}
                  </span>
                </div>
              ))}
              {visible.length === 0 && (
                <div style={{ padding: 8, fontSize: 12, color: "var(--text-faint)" }}>
                  {enabledOnly && models.length > 0
                    ? "有効なモデルがありません(設定でモデルを有効にしてください)"
                    : "該当するモデルがありません"}
                </div>
              )}
            </div>
          </label>
        </>
      )}
    </div>
  );
}
