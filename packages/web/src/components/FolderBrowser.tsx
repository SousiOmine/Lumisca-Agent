import { useEffect, useState } from "react";
import {
  IconArrowLeft,
  IconArrowUp,
  IconChevronRight,
  IconDeviceDesktop,
  IconFolder,
} from "@tabler/icons-react";
import { workspaceApi } from "../api.ts";
import { errorText } from "../providers.ts";

interface BrowseEntry {
  name: string;
  path: string;
}

/** In-app filesystem browser for picking a workspace folder (the fallback
 * when the desktop shell's native picker is unavailable). Browsing happens
 * on the peer that owns the workspace (its filesystem). */
export function FolderBrowser({
  peerId,
  peerName,
  onAdd,
  onBack,
}: {
  peerId: string;
  peerName: string;
  onAdd: (path: string) => void;
  onBack: () => void;
}) {
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  // Browsing happens on the peer that owns the workspace (its filesystem).
  const wsApi = workspaceApi(peerId);
  const fsRoots = () => wsApi.fsRoots();
  const fsBrowse = (p: string) => wsApi.fsBrowse(p);

  useEffect(() => {
    fsRoots().then(setRoots).catch((e) => setError(errorText(e)));
  }, [peerId]);

  useEffect(() => {
    if (path === null) return;
    // Ignore responses for a path we navigated away from (rapid 上へ clicks).
    let stale = false;
    setError(undefined);
    fsBrowse(path)
      .then((r) => {
        if (stale) return;
        setParent(r.parent);
        setEntries(r.entries);
      })
      .catch((e) => {
        if (!stale) setError(errorText(e));
      });
    return () => {
      stale = true;
    };
  }, [path, peerId]);

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
          <button type="button" className="btn" onClick={onBack}>
            <IconArrowLeft size={14} /> 戻る
          </button>
          <h2>フォルダを選択</h2>
        </div>
        <p className="settings-note">
          {peerId === ""
            ? "このサーバーの場所を選択してください"
            : `${peerName} (${peerId}) の場所を選択してください`}
        </p>
        <div className="model-list" style={{ maxHeight: 320 }}>
          {roots.map((r) => (
            <div
              key={r}
              className="model-item"
              onClick={() => go(r)}
            >
              <span className="folder-icon">
                <IconDeviceDesktop size={16} />
              </span>
              <span className="model-id">{r}</span>
              <span className="chevron">
                <IconChevronRight size={14} />
              </span>
            </div>
          ))}
          {roots.length === 0 && (
            <div
              style={{ padding: 8, fontSize: 12, color: "var(--text-faint)" }}
            >
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
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> 戻る
        </button>
        <h2>フォルダを選択</h2>
      </div>
      <div className="browse-path mono">{path}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn"
          onClick={() => go(parent)}
          disabled={!parent}
        >
          <IconArrowUp size={14} />
          上へ
        </button>
        <button type="button" className="btn" onClick={() => go(null)}>
          <IconDeviceDesktop size={14} />
          場所を選び直す
        </button>
      </div>
      <div className="model-list" style={{ maxHeight: 280 }}>
        {entries.map((e) => (
          <div
            key={e.path}
            className="model-item"
            onClick={() => go(e.path)}
          >
            <span className="folder-icon">
              <IconFolder size={16} />
            </span>
            <span className="model-id">{e.name}</span>
            <span className="chevron">
              <IconChevronRight size={14} />
            </span>
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
        <button type="button" className="btn" onClick={onBack}>
          キャンセル
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => onAdd(path)}
        >
          このフォルダを追加
        </button>
      </div>
    </>
  );
}
