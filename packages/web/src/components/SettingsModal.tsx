import { useEffect, useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconChevronRight,
  IconPlugConnected,
  IconX,
} from "@tabler/icons-react";
import { api } from "../api.ts";
import { formatModelMeta } from "../format.ts";
import type { ModelInfo, ProviderInfo } from "../types.ts";
import { Modal } from "./Modal.tsx";

interface SettingsModalProps {
  onClose: () => void;
}

type View =
  | { kind: "home" }
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; providerId: string; isNew: boolean };

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [view, setView] = useState<View>({ kind: "home" });

  return (
    <Modal width="min(720px, calc(100vw - 48px))" onClose={onClose}>
      {view.kind === "home" && <HomeView
        onOpenProviders={() => setView({ kind: "list" })}
        onClose={onClose}
      />}
      {view.kind === "list" && <ProviderList
        onBack={() => setView({ kind: "home" })}
        onAdd={() => setView({ kind: "add" })}
        onOpen={(id) => setView({ kind: "detail", providerId: id, isNew: false })}
        onClose={onClose}
      />}
      {view.kind === "add" && <AddProviderFlow
        onSelect={(id) => setView({ kind: "detail", providerId: id, isNew: true })}
        onBack={() => setView({ kind: "list" })}
      />}
      {view.kind === "detail" && <ProviderDetail
        providerId={view.providerId}
        isNew={view.isNew}
        onBack={() => setView({ kind: "list" })}
      />}
    </Modal>
  );
}

// --- settings home -------------------------------------------------------------

function HomeView({
  onOpenProviders,
  onClose,
}: {
  onOpenProviders: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="modal-header">
        <h2>設定</h2>
        <button className="btn push" onClick={onClose}>
          <IconX size={14} />
          閉じる
        </button>
      </div>
      <div className="settings-menu">
        <button className="settings-menu-item" onClick={onOpenProviders}>
          <span className="settings-menu-icon">
            <IconPlugConnected size={20} />
          </span>
          <span className="settings-menu-text">
            <span className="settings-menu-title">プロバイダー</span>
            <span className="settings-menu-desc">APIキーの登録と、モデルの有効/無効の管理</span>
          </span>
          <span className="chevron">
            <IconChevronRight size={16} />
          </span>
        </button>
      </div>
    </>
  );
}

// --- provider list -----------------------------------------------------------

function ProviderList({
  onBack,
  onAdd,
  onOpen,
  onClose,
}: {
  onBack: () => void;
  onAdd: () => void;
  onOpen: (providerId: string) => void;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    api.listProviders().then(setProviders).catch(console.error);
  }, []);

  const configured = providers.filter((p) => p.configured !== false);
  const others = providers.filter((p) => p.configured === false);

  return (
    <>
      <div className="modal-header">
        <button className="btn" onClick={onBack}><IconArrowLeft size={14} /> 戻る</button>
        <h2>プロバイダー</h2>
        <button className="btn push" onClick={onClose}>閉じる</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p className="settings-note">
          設定済みプロバイダー
        </p>
        {configured.length === 0 && (
          <div className="faint-box">
            まだありません。下の「プロバイダーを追加」から始めてください。
          </div>
        )}
        {configured.map((p) => (
          <button key={p.id} className="btn" style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 10 }}
            onClick={() => onOpen(p.id)}>
            <span style={{ flex: 1 }}>{p.name}</span>
            <span className="provider-state configured">
              {p.source ?? "APIキー"}
            </span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <p className="settings-note">
          未設定のプロバイダー
        </p>
        {others.slice(0, 12).map((p) => (
          <button key={p.id} className="btn" style={{ textAlign: "left" }} onClick={() => onOpen(p.id)}>
            {p.name}
          </button>
        ))}
        {others.length > 12 && (
          <p className="settings-note">
            …ほか {others.length - 12} 件(プロバイダーを追加から選択できます)
          </p>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn primary" onClick={onAdd}>+ プロバイダーを追加</button>
      </div>
    </>
  );
}

// --- add provider flow --------------------------------------------------------

function AddProviderFlow({
  onSelect,
  onBack,
}: {
  onSelect: (providerId: string) => void;
  onBack: () => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.listProviders().then(setProviders).catch(console.error);
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
    );
  }, [providers, search]);

  return (
    <>
      <div className="modal-header">
        <button className="btn" onClick={onBack}><IconArrowLeft size={14} /> 戻る</button>
        <h2>プロバイダーを追加</h2>
      </div>
      <p className="settings-note">
        追加するプロバイダーを選択してください
      </p>
      <input
        placeholder="プロバイダーを検索..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="model-list" style={{ maxHeight: 360 }}>
        {visible.map((p) => (
          <div key={p.id} className="model-item" onClick={() => onSelect(p.id)}>
            <span className="model-id">{p.name}</span>
            <span className="model-meta">{p.id}</span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="faint-box">
            該当するプロバイダーがありません
          </div>
        )}
      </div>
    </>
  );
}

// --- provider detail ----------------------------------------------------------

function ProviderDetail({
  providerId,
  isNew,
  onBack,
}: {
  providerId: string;
  isNew: boolean;
  onBack: () => void;
}) {
  const [provider, setProvider] = useState<ProviderInfo | undefined>();
  const [auth, setAuth] = useState<{ configured: boolean; source?: string }>({ configured: false });
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [search, setSearch] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [savedNotice, setSavedNotice] = useState(false);

  const load = async () => {
    const [ps, authState, ms] = await Promise.all([
      api.listProviders(),
      api.providerAuth(providerId),
      api.listModels(providerId),
    ]);
    setProvider(ps.find((p) => p.id === providerId));
    setAuth(authState);
    setModels(ms);
  };

  useEffect(() => {
    load().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = showDisabled
      ? models.filter((m) => m.enabled === false)
      : models;
    if (!q) return base;
    return base.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
    );
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(false);
    }
  };

  const toggleModel = async (modelId: string, enabled: boolean) => {
    setModels((ms) => ms.map((m) => (m.id === modelId ? { ...m, enabled } : m)));
    try {
      await api.setModelEnabled(providerId, modelId, enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const enabledCount = models.filter((m) => m.enabled !== false).length;

  return (
    <>
      <div className="modal-header">
        <button className="btn" onClick={onBack}><IconArrowLeft size={14} /> 戻る</button>
        <h2>{provider?.name ?? providerId}</h2>
        {auth.configured
          ? <span className="provider-state configured">設定済み</span>
          : <span className="provider-state">未設定</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <p className="settings-note">APIキー</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            placeholder={auth.configured ? "新しいAPIキー(上書き)" : "APIキーを入力"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary" onClick={saveKey} disabled={savingKey || !key.trim()}>
            保存
          </button>
        </div>
        {savedNotice && <p className="settings-note" style={{ color: "var(--ok)" }}>APIキーを保存しました</p>}
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
          <label style={{ flexDirection: "row", alignItems: "center", gap: 4, fontSize: 12 }}>
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
            <label key={m.id} className="model-item" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={m.enabled !== false}
                onChange={(e) => toggleModel(m.id, e.target.checked)}
              />
              <span className="model-id">{m.id}</span>
              <span className="model-meta">
                {formatModelMeta(m.contextWindow, m.reasoning)}
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
        <button className="btn primary" onClick={onBack}>
          完了
        </button>
      </div>
    </>
  );
}
