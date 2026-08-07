import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { formatModelMeta } from "@lumisca/core/shared";
import type { ModelInfo } from "../types.ts";
import { filterByQuery } from "../providers.ts";

export interface ModelPickerProps {
  value: { provider: string; modelId: string } | null;
  /** Only show models the user enabled in settings. Default true. */
  enabledOnly?: boolean;
  /** Called with the selected model; the ModelInfo lets the caller know
   * the model's thinking levels without another fetch. */
  onSelect: (
    provider: string,
    modelId: string,
    info?: ModelInfo,
  ) => void;
}

/** Provider + searchable model selection, shared by modals and the chat bar.
 * Only providers with configured credentials are offered. */
export function ModelPicker({
  value,
  enabledOnly = true,
  onSelect,
}: ModelPickerProps) {
  const [providers, setProviders] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providerId, setProviderId] = useState(value?.provider ?? "");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api.listProviders()
      .then((ps) => {
        if (stale) return;
        const configured = ps.filter((p) => p.configured !== false);
        // Keep the currently selected provider in the list even when it has
        // no configured credentials, so the dropdown matches the selection.
        const current = value?.provider;
        const list = current && !configured.some((p) => p.id === current)
          ? [...configured, {
            id: current,
            name: ps.find((p) => p.id === current)?.name ?? current,
          }]
          : configured;
        setProviders(list);
        if (!providerId && list.length > 0) {
          setProviderId(list[0]!.id);
        }
      })
      .catch(() => {
        if (!stale) {
          setError(
            "プロバイダー一覧を取得できませんでした(サーバーに接続できません)",
          );
        }
      });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (!providerId) return;
    // Drop stale responses: switching providers quickly must never show the
    // models of a previous provider under the new one.
    let stale = false;
    setBusy(true);
    setModels([]);
    api.listModels(providerId)
      .then((ms) => {
        if (!stale) setModels(ms);
      })
      .catch(() => {
        if (!stale) setError("モデル一覧を取得できませんでした");
      })
      .finally(() => {
        if (!stale) setBusy(false);
      });
    return () => {
      stale = true;
    };
  }, [providerId]);

  // Follow external value changes (e.g. the session model switched while
  // the picker stayed mounted).
  useEffect(() => {
    if (value?.provider && value.provider !== providerId) {
      setProviderId(value.provider);
    }
  }, [value?.provider, providerId]);

  const visible = useMemo(() => {
    const list = enabledOnly
      ? models.filter((m) => m.enabled !== false)
      : models;
    return filterByQuery(list, search);
  }, [models, search, enabledOnly]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {error !== null
        ? <div className="error-text">{error}</div>
        : providers.length === 0
        ? (
          <div className="settings-note" style={{ padding: 6 }}>
            設定済みのプロバイダーがありません。
            設定画面からAPIキーを登録してください。
          </div>
        )
        : (
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
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              モデル{busy && (
                <span style={{ color: "var(--accent)" }}>読み込み中...</span>
              )}
              <input
                placeholder="モデルを検索..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="model-list">
                {visible.slice(0, 200).map((m) => (
                  <div
                    key={m.id}
                    className={`model-item${
                      value?.modelId === m.id ? " selected" : ""
                    }`}
                    onClick={() => onSelect(providerId, m.id, m)}
                  >
                    <span className="model-id">{m.id}</span>
                    <span className="model-meta">
                      {formatModelMeta(m.contextWindow, m.reasoning)}
                    </span>
                  </div>
                ))}
                {visible.length === 0 && (
                  <div
                    style={{
                      padding: 8,
                      fontSize: 12,
                      color: "var(--text-faint)",
                    }}
                  >
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
