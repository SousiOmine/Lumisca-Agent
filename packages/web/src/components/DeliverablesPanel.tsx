import { useState } from "preact/compat";
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClipboard,
  IconFile,
} from "@tabler/icons-preact";
import { TOOL_PRESENT } from "@lumisca/core/shared";
import type { AgentMessage } from "../types.ts";

/** A single deliverable file entry extracted from a successful `present`
 * tool call. */
export interface DeliverableFile {
  path: string;
  description?: string;
}

/** Scan the transcript for successful `present` tool-result messages and
 * extract the file list from each. Returns files in order of first
 * declaration, deduplicated by path (the latest description wins). Pure, so
 * a session restored from the database derives the same panel. */
export function deliverablesOf(
  messages: AgentMessage[],
): DeliverableFile[] {
  const seen = new Map<string, { file: DeliverableFile; order: number }>();
  let order = 0;
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== TOOL_PRESENT) continue;
    if (msg.isError) continue;
    const details = msg.details as Record<string, unknown> | undefined;
    if (!details) continue;
    const files = details.files;
    if (!Array.isArray(files)) continue;
    for (const entry of files) {
      if (!entry || typeof entry !== "object") continue;
      const { path, description } = entry as Record<string, unknown>;
      if (typeof path !== "string" || !path) continue;
      const existing = seen.get(path);
      if (existing) {
        existing.file = {
          path,
          description: typeof description === "string"
            ? description
            : existing.file.description,
        };
      } else {
        seen.set(path, {
          file: {
            path,
            description: typeof description === "string"
              ? description
              : undefined,
          },
          order: order++,
        });
      }
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.order - b.order)
    .map((v) => v.file);
}

/** Copy text to the clipboard and briefly flash a check-mark feedback. */
function useCopyFeedback() {
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(text);
      setTimeout(() => setCopiedPath(null), 1500);
    } catch {
      // clipboard API unavailable — silent fail
    }
  };
  return { copiedPath, copy };
}

/** The session's deliverables (the present tool), shown as a rounded
 * panel fixed to the top-right of the chat (same stack as todo/tasks).
 * Renders nothing while the list is empty; the header collapses the body
 * to a compact pill. */
export function DeliverablesPanel(
  { deliverables }: { deliverables: DeliverableFile[] },
) {
  const [collapsed, setCollapsed] = useState(false);
  const { copiedPath, copy } = useCopyFeedback();
  if (deliverables.length === 0) return null;
  return (
    <div className={`deliverables-panel${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="deliverables-panel-header"
        title={collapsed ? "展開" : "折りたたみ"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <IconFile size={14} />
        <span className="deliverables-panel-title">成果物</span>
        <span className="deliverables-panel-summary">
          {deliverables.length}
        </span>
        {collapsed
          ? <IconChevronDown size={14} />
          : <IconChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div className="deliverables-panel-body">
          {deliverables.map((file) => (
            <div key={file.path} className="deliverable-item">
              <button
                type="button"
                className="deliverable-path"
                title={`クリックでコピー: ${file.path}`}
                onClick={() =>
                  copy(file.path)}
              >
                <span className="deliverable-path-text">{file.path}</span>
                {copiedPath === file.path
                  ? <IconCheck size={12} className="deliverable-copied" />
                  : (
                    <IconClipboard
                      size={12}
                      className="deliverable-copy-icon"
                    />
                  )}
              </button>
              {file.description && (
                <div className="deliverable-description">
                  {file.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
