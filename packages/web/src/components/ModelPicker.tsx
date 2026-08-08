import { useEffect, useMemo, useRef, useState } from "react";
import { IconBrain } from "@tabler/icons-react";
import { api, fed } from "../api.ts";
import { formatModelMeta } from "@lumisca/core/shared";
import type { ModelInfo } from "../types.ts";
import { filterByQuery } from "../providers.ts";

export interface ModelPickerProps {
  value: { provider: string; modelId: string } | null;
  /** Only show models the user enabled in settings. Default true. */
  enabledOnly?: boolean;
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
}

/** Provider + searchable model selection, shared by modals and the chat bar.
 * Only providers with configured credentials are offered. */
export function ModelPicker({
  value,
  enabledOnly = true,
  peerId = "",
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
    const listProviders = peerId === ""
      ? api.listProviders()
      : fed.listProviders(peerId);
    listProviders
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
  }, [peerId]);

  useEffect(() => {
    if (!providerId) return;
    // Drop stale responses: switching providers quickly must never show the
    // models of a previous provider under the new one.
    let stale = false;
    setBusy(true);
    setModels([]);
    const listModels = peerId === ""
      ? api.listModels(providerId)
      : fed.listModels(peerId, providerId);
    listModels
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
  }, [providerId, peerId]);

  // Follow external value changes (e.g. the session model switched while
  // the picker stayed mounted). Only react when the prop itself changes:
  // comparing against providerId would also fire on the user's own dropdown
  // selection and yank the picker back to the previously selected provider.
  const externalProvider = useRef(value?.provider ?? null);
  useEffect(() => {
    const next = value?.provider ?? null;
    if (next !== null && next !== externalProvider.current) {
      externalProvider.current = next;
      setProviderId(next);
    }
  }, [value?.provider]);

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
                      {formatModelMeta(m.contextWindow)}
                      {m.reasoning && (
                        <IconBrain
                          size={12}
                          title="思考モデル"
                          aria-label="思考モデル"
                        />
                      )}
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
