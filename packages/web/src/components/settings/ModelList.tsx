import { useMemo, useState } from "preact/compat";
import { IconChevronRight, IconPlugConnected } from "@tabler/icons-preact";
import {
  errorText,
  filterByQuery,
  setModelEnabled,
  useProviderModels,
} from "../../providers.ts";
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
  const [saveError, setSaveError] = useState<string | undefined>();

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

  /** Persist a toggle. The helper writes the new value to the catalog store
   * before the request (and reverts it on failure), so the switch, the group
   * count and the model pickers all follow one source of truth — and the
   * value survives this list remounting (reopening the settings dialog). */
  const toggleModel = async (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => {
    setSaveError(undefined);
    try {
      await setModelEnabled(providerId, modelId, enabled);
    } catch (e) {
      setSaveError(errorText(e));
    }
  };

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
        <h2>モデル設定</h2>
      </div>

      <input
        placeholder="モデルを検索…"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />

      {loading && <div className="faint-box">読み込み中…</div>}

      {!loading && filtered.length === 0 && (
        <div className="faint-box">
          {configured.length === 0
            ? "利用可能なプロバイダーが未設定です。「APIプロバイダー」からAPIキーを登録してください。"
            : "該当するモデルがありません"}
        </div>
      )}

      <div className="model-groups">
        {filtered.map((pm) => {
          const isExpanded = expanded[pm.providerId] ?? false;
          // Enabled is the default; only a disabled model carries the flag.
          const enabledCount = pm.models.filter((m) => m.enabled !== false)
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
                          checked={m.enabled !== false}
                          onChange={(e) =>
                            toggleModel(
                              pm.providerId,
                              m.id,
                              e.currentTarget.checked,
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
      {saveError && (
        <div className="error-text">保存に失敗しました: {saveError}</div>
      )}
    </>
  );
}
