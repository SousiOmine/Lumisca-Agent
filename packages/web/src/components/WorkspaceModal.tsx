import { useEffect, useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { workspaceApi } from "../api.ts";
import type { Workspace } from "../types.ts";
import { Modal } from "./Modal.tsx";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { errorText } from "../providers.ts";
import { nativeFolderPickerAvailable, pickFolder } from "../shell.ts";

interface WorkspaceModalProps {
  /** Present → edit mode (rename / change folders / delete). */
  workspace?: Workspace;
  /** Peer owning the workspace ("" = this server). Browsing, saving and
   * deleting are proxied to that peer, so workspaces can be registered
   * and edited on other machines. */
  peerId: string;
  /** Peer name for the folder-browser caption. */
  peerName: string;
  onSaved: (ws: Workspace) => void;
  /** The App-owned delete flow (confirm + API + state). */
  onDelete: (
    fws: { peerId: string; peerName: string; workspace: Workspace },
  ) => Promise<void>;
  onClose: () => void;
}

type View = { kind: "main" } | { kind: "browse" };

export function WorkspaceModal(
  { workspace, peerId, peerName, onSaved, onDelete, onClose }:
    WorkspaceModalProps,
) {
  const editing = workspace !== undefined;
  const [view, setView] = useState<View>({ kind: "main" });
  const [name, setName] = useState(workspace?.name ?? "");
  const [folders, setFolders] = useState<string[]>(workspace?.folders ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // True when the desktop shell is displaying the local server, so the OS
  // folder picker (which returns paths on this machine) is meaningful.
  const [nativePicker, setNativePicker] = useState(false);
  const [picking, setPicking] = useState(false);
  // All API calls target the peer that owns the workspace.
  const wsApi = workspaceApi(peerId);

  useEffect(() => {
    nativeFolderPickerAvailable().then(setNativePicker);
  }, []);

  const addFolder = (path: string) => {
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setView({ kind: "main" });
  };

  const pickNative = async () => {
    setPicking(true);
    setError(undefined);
    try {
      const path = await pickFolder();
      if (path) addFolder(path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPicking(false);
    }
  };

  // The native OS picker returns paths on this machine, so it only applies
  // to workspaces owned by the displayed local server; otherwise fall back
  // to the in-app browser.
  const chooseFolder = () => {
    if (nativePicker && peerId === "") {
      pickNative();
    } else {
      setView({ kind: "browse" });
    }
  };

  const save = async () => {
    if (!name.trim() || folders.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const ws = editing
        ? await wsApi.update(workspace!.id, {
          name: name.trim(),
          folders,
        })
        : await wsApi.create(name.trim(), folders);
      onSaved(ws);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || !workspace || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDelete({ peerId, peerName, workspace });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      {view.kind === "browse"
        ? (
          <FolderBrowser
            peerId={peerId}
            peerName={peerName}
            onAdd={addFolder}
            onBack={() => setView({ kind: "main" })}
          />
        )
        : (
          <>
            <h2>{editing ? "ワークスペースを編集" : "新しいワークスペース"}</h2>

            <p className="settings-note">
              対象サーバー: {peerId === "" ? "このサーバー" : peerName}
            </p>

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
                  type="button"
                  className="btn"
                  onClick={chooseFolder}
                  disabled={picking}
                >
                  <IconPlus size={14} />
                  {picking ? "選択中..." : "フォルダを選択"}
                </button>
              </div>
            </label>

            {folders.length > 0 && (
              <div className="folder-list">
                {folders.map((f) => (
                  <div key={f} className="folder-item">
                    <span className="mono folder-path" title={f}>{f}</span>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        setFolders((prev) => prev.filter((p) => p !== f))}
                    >
                      <IconTrash size={13} />
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
              {editing && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={remove}
                  disabled={busy}
                >
                  <IconTrash size={14} />
                  削除
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>
                キャンセル
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={save}
                disabled={busy || !name.trim() || folders.length === 0}
              >
                {busy ? "保存中..." : editing ? "保存" : "作成"}
              </button>
            </div>
          </>
        )}
    </Modal>
  );
}
