import { useEffect, useState } from "react";
import {
  IconArrowLeft,
  IconArrowUp,
  IconChevronRight,
  IconDeviceDesktop,
  IconFolder,
} from "@tabler/icons-react";
import { api } from "../api.ts";
import type { Workspace } from "../types.ts";
import { Modal } from "./Modal.tsx";

interface WorkspaceModalProps {
  onCreated: (ws: Workspace) => void;
  onClose: () => void;
}

type View = { kind: "main" } | { kind: "browse" };

export function WorkspaceModal({ onCreated, onClose }: WorkspaceModalProps) {
  const [view, setView] = useState<View>({ kind: "main" });
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const addFolder = (path: string) => {
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setView({ kind: "main" });
  };

  const create = async () => {
    if (!name.trim() || folders.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const ws = await api.createWorkspace(name.trim(), folders);
      onCreated(ws);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      {view.kind === "browse"
        ? (
            <FolderBrowser
              onAdd={addFolder}
              onBack={() => setView({ kind: "main" })}
            />
          )
          : (
            <>
              <h2>新しいワークスペース</h2>

              <label>
                名前
                <input
                  placeholder="例: プロジェクトA"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label>
                フォルダ
                <div className="folder-picker">
                  <button
                    className="btn"
                    onClick={() => setView({ kind: "browse" })}
                  >
                    + フォルダを選択
                  </button>
                </div>
              </label>

              {folders.length > 0 && (
                <div className="folder-list">
                  {folders.map((f) => (
                    <div key={f} className="folder-item">
                      <span className="mono folder-path" title={f}>{f}</span>
                      <button
                        className="btn small"
                        onClick={() => setFolders((prev) => prev.filter((p) => p !== f))}
                      >
                        削除
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="settings-note">
                複数のフォルダをまとめた単位でセッションを作成できます。
                AIのファイル操作はここで指定したフォルダ内に制限されます。
              </p>

              {error && <div className="error-text">{error}</div>}

              <div className="modal-actions">
                <button className="btn" onClick={onClose}>キャンセル</button>
                <button
                  className="btn primary"
                  onClick={create}
                  disabled={busy || !name.trim() || folders.length === 0}
                >
                  {busy ? "作成中..." : "作成"}
                </button>
              </div>
            </>
          )}
    </Modal>
  );
}

// --- folder browser ------------------------------------------------------------

interface BrowseEntry {
  name: string;
  path: string;
}

function FolderBrowser({
  onAdd,
  onBack,
}: {
  onAdd: (path: string) => void;
  onBack: () => void;
}) {
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api.fsRoots().then(setRoots).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (path === null) return;
    setError(undefined);
    api.fsBrowse(path)
      .then((r) => {
        setParent(r.parent);
        setEntries(r.entries);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [path]);

  const go = (p: string | null) => {
    if (p === null) {
      setPath(null);
      setParent(null);
      setEntries([]);
    } else {
      setPath(p);
    }
  };

  if (path === null) {
    return (
      <>
        <div className="modal-header">
          <button className="btn" onClick={onBack}><IconArrowLeft size={14} /> 戻る</button>
          <h2>フォルダを選択</h2>
        </div>
        <p className="settings-note">
          場所を選択してください
        </p>
        <div className="model-list" style={{ maxHeight: 320 }}>
          {roots.map((r) => (
            <div key={r} className="model-item" onClick={() => go(r)}>
              <span className="folder-icon"><IconDeviceDesktop size={16} /></span>
              <span className="model-id">{r}</span>
              <span className="chevron"><IconChevronRight size={14} /></span>
            </div>
          ))}
          {roots.length === 0 && (
            <div style={{ padding: 8, fontSize: 12, color: "var(--text-faint)" }}>
              場所が見つかりません
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="modal-header">
        <button className="btn" onClick={onBack}><IconArrowLeft size={14} /> 戻る</button>
        <h2>フォルダを選択</h2>
      </div>
      <div className="browse-path mono">{path}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={() => go(parent)} disabled={!parent}>
          <IconArrowUp size={14} />
          上へ
        </button>
        <button className="btn" onClick={() => go(null)}>
          <IconDeviceDesktop size={14} />
          場所を選び直す
        </button>
      </div>
      <div className="model-list" style={{ maxHeight: 280 }}>
        {entries.map((e) => (
          <div key={e.path} className="model-item" onClick={() => go(e.path)}>
            <span className="folder-icon"><IconFolder size={16} /></span>
            <span className="model-id">{e.name}</span>
            <span className="chevron"><IconChevronRight size={14} /></span>
          </div>
        ))}
        {entries.length === 0 && (
          <div style={{ padding: 8, fontSize: 12, color: "var(--text-faint)" }}>
            (サブフォルダはありません)
          </div>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onBack}>キャンセル</button>
        <button className="btn primary" onClick={() => onAdd(path)}>
          このフォルダを追加
        </button>
      </div>
    </>
  );
}
