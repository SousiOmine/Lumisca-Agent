import { useEffect, useState } from "react";
import {
  IconArrowLeft,
  IconCheck,
  IconCircleDashed,
} from "@tabler/icons-react";
import { api } from "../../api.ts";
import { errorText, useProviders } from "../../providers.ts";

/** Settings → one provider: API key entry only. */
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
  const [error, setError] = useState<string | undefined>();
  const [savedNotice, setSavedNotice] = useState(false);

  const load = async () => {
    const authState = await api.providerAuth(providerId);
    setAuth(authState);
  };

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
