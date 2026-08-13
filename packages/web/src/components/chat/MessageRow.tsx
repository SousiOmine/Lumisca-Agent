import { contentImages, contentText } from "@lumisca/core/shared";
import type {
  AgentMessage,
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
} from "../../types.ts";
import { ToolCall } from "../ToolCall.tsx";
import { NotificationRow } from "../NotificationRow.tsx";
import { CopyableUserMessage } from "./CopyableUserMessage.tsx";
import { MarkdownBlock } from "./MarkdownBlock.tsx";
import type { UserMessageImage } from "./types.ts";

/** One message of a turn: user messages get the action row, notifications
 * are compact rows, assistant messages render text + tool calls. */
export function MessageRow({
  message,
  toolResults,
  runningTools,
  onRewind,
}: {
  message: AgentMessage;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
  onRewind?: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
}) {
  if (message.role === "toolResult") return null;

  // System notifications are compact one-line rows, not user messages.
  if (message.role === "notification") {
    return <NotificationRow message={message} />;
  }

  if (message.role === "user") {
    const text = contentText(message.content);
    const imageBlocks = contentImages(message.content);
    return (
      <CopyableUserMessage
        text={text}
        images={imageBlocks}
        timestamp={message.timestamp}
        onRewind={onRewind ?? (() => {})}
      />
    );
  }

  const assistant = message as AssistantMessage;
  const text = contentText(assistant.content);
  const toolCalls = assistant.content.filter(
    (b): b is ToolCallBlock => b.type === "toolCall",
  );

  return (
    <div className="msg">
      <div className="msg-body markdown">
        {text && <MarkdownBlock text={text} />}
        {toolCalls.map((tc) => (
          <ToolCall
            key={tc.id}
            toolCall={tc}
            result={toolResults.get(tc.id)}
            running={runningTools.has(tc.id)}
          />
        ))}
      </div>
    </div>
  );
}
