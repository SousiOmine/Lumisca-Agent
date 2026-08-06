import { useEffect, useRef, useState } from "react";
import {
  IconChevronDown,
  IconFolder,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { Workspace } from "../types.ts";

interface WorkspacePickerProps {
  workspaces: Workspace[];
  /** Currently selected workspace id ("" when none). */
  value: string;
  onChange: (id: string) => void;
  onEdit: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  onCreate: () => void;
}

/** Custom workspace dropdown with per-item edit/delete actions. */
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

  const selected = workspaces.find((w) => w.id === value);

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="workspace-picker" ref={rootRef}>
      <button
        type="button"
        className="workspace-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? selected.name : "ワークスペースを選択"}
      >
        <span className="workspace-picker-name">
          {selected ? selected.name : "(ワークスペースがありません)"}
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
          {workspaces.map((w) => (
            <div
              key={w.id}
              role="option"
              aria-selected={w.id === value}
              className={`workspace-option${w.id === value ? " selected" : ""}`}
              onClick={() => {
                onChange(w.id);
                setOpen(false);
              }}
            >
              <span className="workspace-option-icon">
                <IconFolder size={14} />
              </span>
              <span className="workspace-option-name" title={w.name}>
                {w.name}
              </span>
              <span className="workspace-option-meta">
                {w.folders.length} フォルダ
              </span>
              <span className="workspace-option-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="編集"
                  aria-label={`${w.name} を編集`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onEdit(w);
                  }}
                >
                  <IconPencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="削除"
                  aria-label={`${w.name} を削除`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onDelete(w);
                  }}
                >
                  <IconTrash size={14} />
                </button>
              </span>
            </div>
          ))}
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
