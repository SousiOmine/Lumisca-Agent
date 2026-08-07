import { useEffect, useRef, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { contentText } from "@lumisca/core/shared";
import type { ToolCallBlock, ToolResultMessage } from "../types.ts";

interface ToolCallProps {
  toolCall: ToolCallBlock;
  result?: ToolResultMessage;
  running: boolean;
}

export function ToolCall({ toolCall, result, running }: ToolCallProps) {
  // Live-streaming tool calls mount without a result and stay collapsed
  // otherwise; a result arriving later must expand them, matching restored
  // sessions where the result is present at mount.
  const [open, setOpen] = useState(result !== undefined);
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
