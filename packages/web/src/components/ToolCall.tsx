import { useEffect, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconLoader2,
} from "@tabler/icons-react";
import { contentText } from "@lumisca/core/shared";
import type { ToolCallBlock, ToolResultMessage } from "../types.ts";

interface ToolCallProps {
  toolCall: ToolCallBlock;
  result?: ToolResultMessage;
  running: boolean;
}

export function ToolCall({ toolCall, result, running }: ToolCallProps) {
  // Collapsed by default. Restored sessions mount with results already
  // present, and expanding every tool call would make a long history
  // impossible to scan. A result arriving later (live run) still expands
  // the call so the run stays observable.
  const [open, setOpen] = useState(false);
  const hadResult = useRef(result !== undefined);
  useEffect(() => {
    if (result !== undefined && !hadResult.current) {
      hadResult.current = true;
      setOpen(true);
    }
  }, [result]);

  const state = result
    ? result.isError ? "error" : "done"
    : running
    ? "running"
    : "pending";

  const stateLabel = state === "running"
    ? "実行中"
    : state === "done"
    ? "完了"
    : state === "error"
    ? "エラー"
    : "待機";

  return (
    <div className="tool">
      <div
        className={`tool-head${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="chevron">
          <IconChevronRight size={14} />
        </span>
        <span className="tool-name">{toolCall.name}</span>
        <span className={`tool-state ${state}`}>
          {state === "running" && <IconLoader2 size={11} className="spin" />}
          {state === "done" && <IconCheck size={11} />}
          {state === "error" && <IconAlertTriangle size={11} />}
          {state === "pending" && <IconClock size={11} />}
          {stateLabel}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          <div className="tool-args">
            {JSON.stringify(toolCall.arguments, null, 2)}
          </div>
          {result && (
            <pre className={`tool-result${result.isError ? " error" : ""}`}>
              {contentText(result.content)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
