import type {
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
} from "../../types.ts";
import { ToolCall } from "../ToolCall.tsx";

/** The tool calls of the final assistant message, as a timeline (used in
 * the expanded work log; the final message text renders separately). */
export function AssistantTools({
  assistant,
  toolResults,
  runningTools,
}: {
  assistant: AssistantMessage;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
}) {
  const toolCalls = assistant.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  );
  return (
    <div className="msg">
      <div className="msg-body markdown">
        {toolCalls.map((toolCall) => (
          <ToolCall
            key={toolCall.id}
            toolCall={toolCall}
            result={toolResults.get(toolCall.id)}
            running={runningTools.has(toolCall.id)}
          />
        ))}
      </div>
    </div>
  );
}
