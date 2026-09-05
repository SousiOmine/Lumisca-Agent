import { memo, useState } from "react";
import { contentText } from "@lumisca/core/shared";
import type {
  AgentMessage,
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
} from "../../types.ts";
import { AgentActivity } from "../AgentActivity.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { AssistantText } from "./AssistantText.tsx";
import { AssistantTools } from "./AssistantTools.tsx";
import type { ConversationTurnData, UserMessageImage } from "./types.ts";

export type { ConversationTurnData } from "./types.ts";

/** Group the flat agent history by the message that started each run: a
 * user prompt (plain or mode-generated — mode messages are the slash-command
 * prompts like `/plan 依頼文` or review) or a system notification
 * (background command completions and sub-agent messages also start a run
 * so the agent can react to them). Empty-response retries (kind "retry")
 * are an internal repair and must not split the turn: the retried response
 * then lands in the same turn, and the whole thing collapses together when
 * the run ends. */
export function buildTurns(messages: AgentMessage[]): ConversationTurnData[] {
  const turns: ConversationTurnData[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "mode") {
      turns.push({ user: message, responses: [] });
      continue;
    }
    if (message.role === "notification") {
      if (message.kind === "retry") continue;
      turns.push({ user: message, responses: [] });
      continue;
    }
    const current = turns.at(-1);
    if (current) current.responses.push(message);
  }
  return turns;
}

/** One user prompt and the agent's reaction to it: the activity header,
 * the (expandable) work log of intermediate messages + tool calls, and
 * the final assistant text. Memoized — only the last turn's `running`
 * flag changes while a run streams, so the others skip re-rendering; the
 * callers keep the props referentially stable (see ChatView). */
export const ConversationTurn = memo(function ConversationTurn({
  turn,
  toolResults,
  runningTools,
  running,
  endedAt,
  onRewind,
}: {
  turn: ConversationTurnData;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
  running: boolean;
  endedAt?: number;
  onRewind: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const assistants = turn.responses.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const finalAssistant = assistants.at(-1);
  const intermediate = finalAssistant ? assistants.slice(0, -1) : assistants;
  const finalToolCalls = finalAssistant?.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  ) ?? [];
  const expandable = intermediate.length > 0 || finalToolCalls.length > 0;
  const lastTimestamp = turn.responses.reduce(
    (latest, message) => Math.max(latest, message.timestamp),
    turn.user.timestamp,
  );
  const completionTime = endedAt ?? lastTimestamp;

  return (
    <section className="conversation-turn">
      <MessageRow
        message={turn.user}
        toolResults={toolResults}
        runningTools={runningTools}
        onRewind={onRewind}
      />
      {(running || turn.responses.length > 0) && (
        <AgentActivity
          startedAt={turn.user.timestamp}
          endedAt={running ? undefined : completionTime}
          running={running}
          expanded={running || expanded}
          expandable={!running && expandable}
          onToggle={() => {
            if (!running && expandable) setExpanded((open) => !open);
          }}
        />
      )}
      {(running || expanded) && (
        <div className="agent-work-log">
          {intermediate.map((message, index) => (
            <MessageRow
              key={`${message.timestamp}-${index}`}
              message={message}
              toolResults={toolResults}
              runningTools={runningTools}
            />
          ))}
          {finalAssistant && finalToolCalls.length > 0 && (
            <AssistantTools
              assistant={finalAssistant}
              toolResults={toolResults}
              runningTools={runningTools}
            />
          )}
        </div>
      )}
      {finalAssistant && contentText(finalAssistant.content) && (
        <AssistantText message={finalAssistant} />
      )}
    </section>
  );
});
