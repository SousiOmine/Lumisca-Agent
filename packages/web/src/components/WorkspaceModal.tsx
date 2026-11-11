import { IconPlus, IconTrash } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { useT } from "../i18n.ts";
import { errorText } from "../providers.ts";
import { nativeFolderPickerAvailable, pickFolder } from "../shell.ts";
import type { Workspace } from "../types.ts";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { Modal } from "./Modal.tsx";

interface WorkspaceModalProps {
  /** Present → edit mode (rename / change folders / delete). */
  workspace?: Workspace;
  onSaved: (ws: Workspace) => void;
  /** The App-owned delete flow (confirm + API + state). */
  onDelete: (workspace: Workspace) => Promise<void>;
  onClose: () => void;
}

type View = { kind: "main" } | { kind: "browse" };

export function WorkspaceModal({
  workspace,
  onSaved,
  onDelete,
  onClose,
}: WorkspaceModalProps) {
  const editing = workspace !== undefined;
  const t = useT();
  const [view, setView] = useState<View>({ kind: "main" });
  const [name, setName] = useState(workspace?.name ?? "");
  const [folders, setFolders] = useState<string[]>(workspace?.folders ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // True when the desktop shell is displaying the local server, so the OS
  // folder picker (which returns paths on this machine) is meaningful.
  const [nativePicker, setNativePicker] = useState(false);
  const [picking, setPicking] = useState(false);
  // The dialog's own exit (see Modal): saving and deleting leave through it,
  // so the sheet is not removed mid-write and does not vanish over the
  // caller's next render.
  const closeRef = useRef<(after?: () => void) => void>(() => {});

  useEffect(() => {
    nativeFolderPickerAvailable().then(setNativePicker);
  }, []);

  const addFolder = (path: string) => {
    const added = !folders.includes(path);
    if (added) {
      setFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
      // Fill in the name a new workspace would otherwise need typed by hand,
      // from the folder just picked. The field stays editable, and an
      // existing workspace keeps the name it already has.
      if (!editing && !name.trim()) {
        const base = path.split(/[\\/]/).filter(Boolean).at(-1);
        if (base) setName(base);
      }
    }
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

  // The native OS picker returns paths on this machine; against a remote
  // server those are not the server's paths, so the in-app browser is used
  // there (the shell reports which server is displayed).
  const chooseFolder = () => {
    if (nativePicker) {
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
        ? await api.updateWorkspace(workspace!.id, {
            name: name.trim(),
            folders,
          })
        : await api.createWorkspace(name.trim(), folders);
      // `onSaved` is the caller's bookkeeping (the new workspace becomes the
      // selected one); removing this dialog is `onClose`'s job, which happens
      // once the exit is over.
      onSaved(ws);
      closeRef.current();
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
      await onDelete(workspace);
      closeRef.current();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      label={
        editing
          ? t("chrome.workspaceModal.editTitle")
          : t("chrome.workspaceModal.createTitle")
      }
      // The two-pane browser wants the width of a file manager window; the
      // form view keeps the default dialog width.
      width={
        view.kind === "browse" ? "min(880px, calc(100vw - 48px))" : undefined
      }
    >
      {(close) => {
        closeRef.current = close;
        return view.kind === "browse" ? (
          <FolderBrowser
            onAdd={addFolder}
            onBack={() => setView({ kind: "main" })}
          />
        ) : (
          <>
            <h2>
              {editing
                ? t("chrome.workspaceModal.editTitle")
                : t("chrome.workspaceModal.createTitle")}
            </h2>

            <label>
              {t("chrome.workspaceModal.nameLabel")}
              <input
                placeholder={t("chrome.workspaceModal.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </label>

            <label>
              {t("chrome.workspaceModal.foldersLabel")}
              <div className="folder-picker">
                <button
                  type="button"
                  className="btn"
                  onClick={chooseFolder}
                  disabled={picking}
                >
                  <IconPlus size={14} />
                  {picking
                    ? t("chrome.workspaceModal.picking")
                    : t("chrome.workspaceModal.selectFolder")}
                </button>
              </div>
            </label>

            {folders.length > 0 && (
              <div className="folder-list">
                {folders.map((f) => (
                  <div key={f} className="folder-item">
                    <span className="mono folder-path" title={f}>
                      {f}
                    </span>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        setFolders((prev) => prev.filter((p) => p !== f))
                      }
                    >
                      <IconTrash size={13} />
                      {t("chrome.workspaceModal.removeFolder")}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <p className="settings-note">
              {t("chrome.workspaceModal.description")}
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
                  {t("common.delete")}
                </button>
              )}
              <button type="button" className="btn" onClick={() => close()}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={save}
                disabled={busy || !name.trim() || folders.length === 0}
              >
                {busy
                  ? t("common.saving")
                  : editing
                    ? t("common.save")
                    : t("chrome.workspaceModal.create")}
              </button>
            </div>
          </>
        );
      }}
    </Modal>
  );
}
