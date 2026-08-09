import { useEffect, useMemo, useState } from "react";
import { IconChevronRight, IconPlugConnected } from "@tabler/icons-react";
import { api } from "../../api.ts";
import { filterByQuery, useProviders } from "../../providers.ts";
import type { ModelInfo } from "../../types.ts";

interface ProviderModels {
  providerId: string;
  providerName: string;
  models: ModelInfo[];
}

/** Settings → models: all models grouped by provider with toggle switches. */
export function ModelList() {
  const { providers } = useProviders();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [providerModels, setProviderModels] = useState<ProviderModels[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  // Load models for all configured providers
  useEffect(() => {
    let stale = false;
    const loadAll = async () => {
      setLoading(true);
      setError(undefined);
      const configured = providers.filter((p) => p.configured !== false);
      if (configured.length === 0) {
        if (!stale) {
          setProviderModels([]);
          setLoading(false);
        }
        return;
      }
      try {
        const results = await Promise.all(
          configured.map(async (p) => {
            const models = await api.listModels(p.id);
            return {
              providerId: p.id,
              providerName: p.name,
              models,
            };
          }),
        );
        if (!stale) {
          setProviderModels(results);
          setLoading(false);
        }
      } catch (e) {
        if (!stale) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };
    loadAll();
    return () => {
      stale = true;
    };
  }, [providers]);

  const toggleExpand = (providerId: string) => {
    setExpanded((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  const toggleModel = async (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => {
    setProviderModels((prev) =>
      prev.map((pm) =>
        pm.providerId === providerId
          ? {
            ...pm,
            models: pm.models.map((m) =>
              m.id === modelId ? { ...m, enabled } : m
            ),
          }
          : pm
      )
    );
    try {
      await api.setModelEnabled(providerId, modelId, enabled);
    } catch {
      // Revert on error
      setProviderModels((prev) =>
        prev.map((pm) =>
          pm.providerId === providerId
            ? {
              ...pm,
              models: pm.models.map((m) =>
                m.id === modelId ? { ...m, enabled: !enabled } : m
              ),
            }
            : pm
        )
      );
    }
  };

  // Filter by search query
  const filtered = useMemo(() => {
    if (!search.trim()) return providerModels;
    const q = search.trim().toLowerCase();
    return providerModels
      .map((pm) => ({
        ...pm,
        models: filterByQuery(pm.models, q),
      }))
      .filter((pm) => pm.models.length > 0);
  }, [providerModels, search]);

  return (
    <>
      <div className="modal-header">
        <h2>モデル</h2>
      </div>

      <input
        placeholder="モデルを検索..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && <div className="faint-box">読み込み中...</div>}

      {!loading && filtered.length === 0 && (
        <div className="faint-box">
          {providers.filter((p) => p.configured !== false).length === 0
            ? "設定済みプロバイダーがありません。プロバイダー設定からAPIキーを設定してください。"
            : "該当するモデルがありません"}
        </div>
      )}

      <div className="model-groups">
        {filtered.map((pm) => {
          const isExpanded = expanded[pm.providerId] ?? false;
          const enabledCount = pm.models.filter(
            (m) => m.enabled !== false,
          ).length;

          return (
            <div key={pm.providerId} className="model-group">
              <button
                type="button"
                className="model-group-header"
                onClick={() => toggleExpand(pm.providerId)}
              >
                <IconChevronRight
                  size={14}
                  className={`model-group-chevron${
                    isExpanded ? " expanded" : ""
                  }`}
                />
                <IconPlugConnected size={14} className="model-group-icon" />
                <span className="model-group-name">{pm.providerName}</span>
                <span className="model-group-count">
                  {enabledCount}/{pm.models.length}
                </span>
              </button>
              {isExpanded && (
                <div className="model-group-items">
                  {pm.models.map((m) => (
                    <div key={m.id} className="model-toggle-item">
                      <span className="model-toggle-name">
                        {m.name ?? m.id}
                      </span>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={m.enabled !== false}
                          onChange={(e) =>
                            toggleModel(pm.providerId, m.id, e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && <div className="error-text">{error}</div>}
    </>
  );
}
