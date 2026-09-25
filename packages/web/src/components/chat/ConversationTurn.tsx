import { memo, useState } from "preact/compat";
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
 * the run ends.
 *
 * A notification steered into the run that was already active
 * (`steered` — the delivery fact the session agent stamps, see
 * injectNotification) did not start a run: it joins that run's turn like a
 * tool result. Splitting the turn for it would make the still-running turn
 * stop being the last one, collapsing its work log mid-run — the agent
 * keeps working, so nothing about the ongoing turn is finished yet.
 *
 * A compaction checkpoint is a row of its own, not part of any turn: it
 * marks where older history was replaced, so it must not be absorbed into
 * the surrounding turn (the retained messages before it belong to their own
 * prompt). Its `responses` stay empty — see ConversationTurn, which renders
 * such a turn without an activity header. */
export function buildTurns(messages: AgentMessage[]): ConversationTurnData[] {
  const turns: ConversationTurnData[] = [];
  // Context snapshots published before the session's first prompt belong to
  // that first turn: they are part of the run it started, not a turn of
  // their own.
  let pending: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "mode") {
      turns.push({ user: message, responses: pending });
      pending = [];
      continue;
    }
    if (message.role === "checkpoint") {
      turns.push({ user: message, responses: pending, standalone: true });
      pending = [];
      continue;
    }
    if (message.role === "notification") {
      if (message.kind === "retry") continue;
      // Steered notifications join the open turn (a checkpoint row cannot
      // take responses, and a leading one has no turn to join: both keep
      // today's behavior of starting a turn of their own, so no message is
      // ever dropped).
      const current = turns.at(-1);
      if (
        message.steered === true && current !== undefined && !current.standalone
      ) {
        current.responses.push(message);
        continue;
      }
      turns.push({ user: message, responses: pending });
      pending = [];
      continue;
    }
    const current = turns.at(-1);
    if (current) current.responses.push(message);
    else pending.push(message);
  }
  return turns;
}

/** One user prompt and the agent's reaction to it: the activity header,
 * the (expandable) work log of everything the turn produced except the
 * final assistant text (intermediate messages, tool calls, the turn's
 * compact rows), and that text below. Memoized — only the last turn's
 * `running` flag changes while a run streams, so the others skip
 * re-rendering; the callers keep the props referentially stable (see
 * ChatView). */
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
  // A checkpoint turn is one compact row: no activity header, no work log
  // (nothing ran for it), no timing.
  if (turn.standalone) {
    return (
      <section className="conversation-turn">
        <MessageRow
          message={turn.user}
          toolResults={toolResults}
          runningTools={runningTools}
        />
      </section>
    );
  }
  const assistants = turn.responses.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const finalAssistant = assistants.at(-1);
  // Everything the turn produced except the final assistant, whose text
  // renders below the log: intermediate assistant messages (their text and
  // tool calls) plus the turn's compact rows — a notification steered into
  // the run, a dynamic-context snapshot. Their relative order is the
  // transcript's; the final assistant's tool calls are appended after them
  // by AssistantTools, which is where they belong.
  const workLog = finalAssistant === undefined
    ? turn.responses
    : turn.responses.filter((message) => message !== finalAssistant);
  const finalToolCalls = finalAssistant?.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  ) ?? [];
  const expandable = workLog.length > 0 || finalToolCalls.length > 0;
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
          {workLog.map((message, index) => (
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
