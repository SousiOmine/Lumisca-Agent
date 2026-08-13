import { useMemo, useState } from "react";
import { IconChevronRight, IconPlugConnected } from "@tabler/icons-react";
import { api } from "../../api.ts";
import { filterByQuery, useProviderModels } from "../../providers.ts";
import type { ModelInfo } from "../../types.ts";

interface ProviderModels {
  providerId: string;
  providerName: string;
  models: ModelInfo[];
}

/** Settings → models: all models grouped by provider with toggle switches. */
export function ModelList() {
  const { providers, modelsByProvider, loading, error } = useProviderModels();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Optimistic toggle overlay, keyed by "providerId/modelId": the checked
  // value while a toggle is in flight, reverted on failure.
  const [pendingToggles, setPendingToggles] = useState<
    Record<string, boolean>
  >({});

  const configured = useMemo(
    () => providers.filter((p) => p.configured !== false),
    [providers],
  );
  // Groups only for providers whose models have actually loaded: a failed
  // fetch (modelsByProvider empty) must not render empty groups.
  const providerModels: ProviderModels[] = useMemo(
    () =>
      configured
        .filter((p) => modelsByProvider.has(p.id))
        .map((p) => ({
          providerId: p.id,
          providerName: p.name,
          models: modelsByProvider.get(p.id) ?? [],
        })),
    [configured, modelsByProvider],
  );

  const toggleModel = async (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => {
    const key = `${providerId}/${modelId}`;
    setPendingToggles((prev) => ({ ...prev, [key]: enabled }));
    try {
      await api.setModelEnabled(providerId, modelId, enabled);
    } catch {
      // Revert on error
      setPendingToggles((prev) => ({ ...prev, [key]: !enabled }));
    }
  };

  /** Effective enabled state: the pending toggle while one is in flight
   * (reverted on failure), otherwise the fetched value. */
  const isEnabled = (pm: ProviderModels, m: ModelInfo): boolean =>
    pendingToggles[`${pm.providerId}/${m.id}`] ?? m.enabled !== false;

  const toggleExpand = (providerId: string) => {
    setExpanded((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
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
          {configured.length === 0
            ? "設定済みプロバイダーがありません。プロバイダー設定からAPIキーを設定してください。"
            : "該当するモデルがありません"}
        </div>
      )}

      <div className="model-groups">
        {filtered.map((pm) => {
          const isExpanded = expanded[pm.providerId] ?? false;
          const enabledCount = pm.models.filter((m) => isEnabled(pm, m))
            .length;

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
                          checked={isEnabled(pm, m)}
                          onChange={(e) =>
                            toggleModel(
                              pm.providerId,
                              m.id,
                              e.target.checked,
                            )}
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

      {error && <div className="error-text">{error.message}</div>}
    </>
  );
}
