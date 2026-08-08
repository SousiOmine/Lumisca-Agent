import { useEffect, useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconBrain,
  IconCheck,
  IconCircleDashed,
} from "@tabler/icons-react";
import { api } from "../../api.ts";
import { formatModelMeta } from "@lumisca/core/shared";
import { errorText, filterByQuery, useProviders } from "../../providers.ts";
import type { ModelInfo } from "../../types.ts";

/** Settings → one provider: API key entry and model enablement. */
export function ProviderDetail({
  providerId,
  isNew,
  onBack,
}: {
  providerId: string;
  isNew: boolean;
  onBack: () => void;
}) {
  const { providers } = useProviders();
  const [auth, setAuth] = useState<{ configured: boolean; source?: string }>({
    configured: false,
  });
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [search, setSearch] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [savedNotice, setSavedNotice] = useState(false);

  const load = async () => {
    const [authState, ms] = await Promise.all([
      api.providerAuth(providerId),
      api.listModels(providerId),
    ]);
    setAuth(authState);
    setModels(ms);
  };

  // Load auth state and the model list when the detail opens (and again if
  // the provider changes while mounted). saveKey refreshes after a save.
  useEffect(() => {
    let stale = false;
    load().catch((e) => {
      if (!stale) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      stale = true;
    };
  }, [providerId]);

  const provider = providers.find((p) => p.id === providerId);

  const visible = useMemo(() => {
    const base = showDisabled
      ? models.filter((m) => m.enabled === false)
      : models;
    return filterByQuery(base, search);
  }, [models, search, showDisabled]);

  const saveKey = async () => {
    if (!key.trim()) return;
    setSavingKey(true);
    setError(undefined);
    try {
      await api.setApiKey(providerId, key.trim());
      setKey("");
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSavingKey(false);
    }
  };

  const toggleModel = async (modelId: string, enabled: boolean) => {
    setModels((ms) =>
      ms.map((m) => (m.id === modelId ? { ...m, enabled } : m))
    );
    try {
      await api.setModelEnabled(providerId, modelId, enabled);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const enabledCount = models.filter((m) => m.enabled !== false).length;

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> 戻る
        </button>
        <h2>{provider?.name ?? providerId}</h2>
        {auth.configured
          ? (
            <span className="provider-state configured">
              <IconCheck size={12} /> 設定済み
            </span>
          )
          : (
            <span className="provider-state">
              <IconCircleDashed size={12} /> 未設定
            </span>
          )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <p className="settings-note">APIキー</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            placeholder={auth.configured
              ? "新しいAPIキー(上書き)"
              : "APIキーを入力"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn primary"
            onClick={saveKey}
            disabled={savingKey || !key.trim()}
          >
            保存
          </button>
        </div>
        {savedNotice && (
          <p className="settings-note" style={{ color: "var(--ok)" }}>
            APIキーを保存しました
          </p>
        )}
        {isNew && !auth.configured && (
          <p className="settings-note">
            APIキーを保存するとこのプロバイダーが利用可能になります(プロバイダー追加完了)。
          </p>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <p className="settings-note" style={{ flex: 1 }}>
            モデル({enabledCount}/{models.length} 有効)
          </p>
          <label
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
            />
            無効のみ表示
          </label>
        </div>
        <input
          placeholder="モデルを検索..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="model-list" style={{ maxHeight: 280 }}>
          {visible.slice(0, 300).map((m) => (
            <label
              key={m.id}
              className="model-item"
              style={{ cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={m.enabled !== false}
                onChange={(e) => toggleModel(m.id, e.target.checked)}
              />
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
            </label>
          ))}
          {visible.length === 0 && (
            <div className="faint-box">
              該当するモデルがありません
            </div>
          )}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onBack}>
          完了
        </button>
      </div>
    </>
  );
}
