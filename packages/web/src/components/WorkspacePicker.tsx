import { useRef, useState } from "react";
import {
  IconChevronDown,
  IconFolder,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { FederatedWorkspace } from "../types.ts";
import { tabKey } from "../tabs.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";

interface WorkspacePickerProps {
  workspaces: FederatedWorkspace[];
  /** Currently selected workspace (composite key; "" when none). */
  value: string;
  onChange: (key: string) => void;
  onEdit: (fws: FederatedWorkspace) => void;
  onDelete: (fws: FederatedWorkspace) => void;
  /** Called when the user wants to create a new workspace. */
  onCreate: () => void;
}

/** Custom workspace dropdown with per-item edit/delete actions.
 * Machine selection is handled by a separate PeerPicker. */
export function WorkspacePicker({
  workspaces,
  value,
  onChange,
  onEdit,
  onDelete,
  onCreate,
}: WorkspacePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = workspaces.find((w) =>
    tabKey(w.peerId, w.workspace.id) === value
  );

  // Close on outside click and Escape.
  useClickOutside(rootRef, () => setOpen(false), open);

  return (
    <div className="workspace-picker" ref={rootRef}>
      <button
        type="button"
        className="workspace-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? selected.workspace.name : "ワークスペースを選択"}
      >
        <span className="workspace-picker-name">
          {selected ? selected.workspace.name : "(ワークスペースがありません)"}
        </span>
        <span className={`workspace-picker-chevron${open ? " open" : ""}`}>
          <IconChevronDown size={15} />
        </span>
      </button>

      {open && (
        <div className="workspace-popover" role="listbox">
          {workspaces.length === 0 && (
            <div className="workspace-popover-empty">
              ワークスペースがありません
            </div>
          )}
          {workspaces.map((fws) => {
            const key = tabKey(fws.peerId, fws.workspace.id);
            return (
              <div
                key={key}
                role="option"
                aria-selected={key === value}
                className={`workspace-option${
                  key === value ? " selected" : ""
                }`}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
              >
                <span className="workspace-option-icon">
                  <IconFolder size={14} />
                </span>
                <span
                  className="workspace-option-name"
                  title={fws.workspace.name}
                >
                  {fws.workspace.name}
                </span>
                <span className="workspace-option-meta">
                  {fws.workspace.folders.length} フォルダ
                </span>
                <span className="workspace-option-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="編集"
                    aria-label={`${fws.workspace.name} を編集`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onEdit(fws);
                    }}
                  >
                    <IconPencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="削除"
                    aria-label={`${fws.workspace.name} を削除`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onDelete(fws);
                    }}
                  >
                    <IconTrash size={14} />
                  </button>
                </span>
              </div>
            );
          })}
          <button
            type="button"
            className="workspace-option create"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            <IconPlus size={14} />
            <span>新しいワークスペースを作成</span>
          </button>
        </div>
      )}
    </div>
  );
}
