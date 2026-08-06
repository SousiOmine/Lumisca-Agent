import { useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { contentText } from "../../../core/content.ts";
import type { ToolCallBlock, ToolResultMessage } from "../types.ts";

interface ToolCallProps {
  toolCall: ToolCallBlock;
  result?: ToolResultMessage;
  running: boolean;
}

export function ToolCall({ toolCall, result, running }: ToolCallProps) {
  const [open, setOpen] = useState(result !== undefined);

  const state = result
    ? result.isError ? "error" : "done"
    : running ? "running" : "pending";

  const stateLabel =
    state === "running" ? "実行中" : state === "done" ? "完了" : state === "error" ? "エラー" : "待機";

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
        <span className={`tool-state ${state}`}>{stateLabel}</span>
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
