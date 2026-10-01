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
import { Deliverables, deliverablesOf } from "./Deliverables.tsx";
import type { ConversationTurnData, UserMessageImage } from "./types.ts";

export type { ConversationTurnData } from "./types.ts";

/** True when the message was delivered into the run that was already
 * active: the `steered` stamp the session agent sets at delivery time for
 * notifications (see injectNotification) and for prompts sent while the
 * agent was working (see promptWhileRunning). Such a message did not start
 * a run, so it must not start a turn either. */
function isSteered(message: AgentMessage): boolean {
  switch (message.role) {
    case "user":
    case "mode":
    case "notification":
      return message.steered === true;
    default:
      return false;
  }
}

/** Group the flat agent history by the message that started each run: a
 * user prompt (plain or mode-generated — mode messages are the slash-command
 * prompts like `/plan 依頼文` or review) or a system notification
 * (background command completions and sub-agent messages also start a run
 * so the agent can react to them). Empty-response retries (kind "retry")
 * are an internal repair and must not split the turn: the retried response
 * then lands in the same turn, and the whole thing collapses together when
 * the run ends.
 *
 * A message steered into the run that was already active joins that run's
 * turn like a tool result, whatever its role — a completion notification,
 * or a prompt the user typed while the agent was working. Splitting the
 * turn for it would make the still-running turn stop being the last one,
 * collapsing its work log mid-run — the agent keeps working, so nothing
 * about the ongoing turn is finished yet.
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
    // A retry notification is an internal repair, not a turn: the message
    // is dropped (the retried response joins the turn it was retried in).
    if (message.role === "notification" && message.kind === "retry") continue;
    if (
      message.role === "user" || message.role === "mode" ||
      message.role === "notification"
    ) {
      // A steered message joins the turn that is open (a checkpoint row
      // cannot take responses, and a leading one has no turn to join: both
      // fall back to starting a turn of their own, so no message is ever
      // dropped).
      const current = turns.at(-1);
      if (isSteered(message) && current !== undefined && !current.standalone) {
        current.responses.push(message);
        continue;
      }
      turns.push({ user: message, responses: pending });
      pending = [];
      continue;
    }
    if (message.role === "checkpoint") {
      turns.push({ user: message, responses: pending, standalone: true });
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
 * compact rows), that text below, and the files the turn declared with the
 * present tool (the deliverable cards) at the end. Memoized — only the last
 * turn's `running` flag changes while a run streams, so the others skip
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
  // tool calls) plus the turn's compact rows — a notification or a prompt
  // steered into the run, a dynamic-context snapshot. Their relative order
  // is the transcript's; the final assistant's tool calls are appended
  // after them by AssistantTools, which is where they belong. A user
  // message inside the log (a prompt steered into the run) keeps its action
  // row: rewind works on it like on a turn's own prompt.
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
  // The files this turn declared with the present tool, listed at its end:
  // the cards travel with the message that declared them, so the next
  // prompt scrolls them away instead of leaving them under the whole
  // conversation. They stay outside the collapsible work log — a run that
  // ended must not hide what the user received.
  const deliverables = deliverablesOf(turn.responses, toolResults);

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
              onRewind={onRewind}
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
      <Deliverables deliverables={deliverables} />
    </section>
  );
});
