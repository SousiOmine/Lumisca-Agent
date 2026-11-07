import { memo, useState } from "preact/compat";
import {
  type AttachmentRef,
  attachmentsOfDetails,
  contentText,
  TOOL_CHAT_ATTACH,
} from "@lumisca/core/shared";
import type {
  AgentMessage,
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
} from "../../types.ts";
import { AgentActivity } from "../AgentActivity.tsx";
import { AttachmentCard } from "./AttachmentCard.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { AssistantText } from "./AssistantText.tsx";
import { AssistantTools } from "./AssistantTools.tsx";
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
 * such a turn without an activity header.
 *
 * A dynamic context snapshot (date, model, skill catalog, workspace
 * instructions, on-demand tools, reply language) is dropped: it is what the
 * model reads, not something said or done in the conversation. It is dropped
 * HERE rather than hidden by MessageRow, because a row that stays in
 * `responses` still counts toward the work log — the turn would offer a
 * disclosure that opens onto nothing.
 *
 * A loaded window usually begins at a prompt, but not always: the server
 * looks back only so far for the turn a page starts in, so a run that
 * outgrew that lookback (a runaway tool loop) hands over rows whose prompt
 * is on an earlier page. Those are returned as a turn of their own with no
 * `user` — a fragment — instead of being dropped or, worse, hung under the
 * NEXT prompt as if they were its output. */
export function buildTurns(messages: AgentMessage[]): ConversationTurnData[] {
  const turns: ConversationTurnData[] = [];
  // Rows that arrived before the next turn starts.
  let pending: AgentMessage[] = [];
  /** Open a turn at `user`, deciding first what the rows before it belong to.
   * Everything before it belongs to the turn whose prompt is on an earlier
   * page: it is drawn as that turn's tail, in its own fragment, so the rows
   * are neither dropped nor shown as this turn's work. A compaction
   * checkpoint is a row of its own and draws no responses, so nothing is hung
   * under it. */
  const startTurn = (user: AgentMessage, standalone = false) => {
    const inherited = pending;
    pending = [];
    if (standalone) {
      if (inherited.length > 0) turns.push({ responses: inherited });
      turns.push({ user, responses: [], standalone: true });
      return;
    }
    if (inherited.length > 0) turns.push({ responses: inherited });
    turns.push({ user, responses: [] });
  };
  for (const message of messages) {
    // A dynamic context snapshot is the model's reading, not part of the
    // conversation: see the doc above.
    if (message.role === "context") continue;
    // A retry notification is an internal repair, not a turn: the message
    // is dropped (the retried response joins the turn it was retried in).
    // The server reads the same rule when it chooses where a window may
    // begin (see the core's startsTranscriptTurn), so a window never opens
    // on a row this drops.
    if (message.role === "notification" && message.kind === "retry") continue;
    if (
      message.role === "user" || message.role === "mode" ||
      message.role === "notification"
    ) {
      // A steered message joins the turn that is open — including a fragment,
      // whose run is the one it was steered into (a checkpoint row cannot
      // take responses, and a leading one has no turn to join: both fall back
      // to starting a turn of their own, so no message is ever dropped).
      const current = turns.at(-1);
      if (isSteered(message) && current !== undefined && !current.standalone) {
        current.responses.push(message);
        continue;
      }
      startTurn(message);
      continue;
    }
    if (message.role === "checkpoint") {
      startTurn(message, true);
      continue;
    }
    const current = turns.at(-1);
    if (current) current.responses.push(message);
    else pending.push(message);
  }
  // Nothing opened a turn in this window: it lies entirely inside one run,
  // so the whole of it is that turn's tail.
  if (pending.length > 0) turns.push({ responses: pending });
  return turns;
}

/** One user prompt and the agent's reaction to it: the activity header, the
 * (expandable) work log of everything the turn produced except the final
 * assistant text (intermediate messages, tool calls, the turn's compact
 * rows), and that text below. Memoized — only the last turn's `running` flag
 * changes while a run streams, so the others skip re-rendering; the callers
 * keep the props referentially stable (see ChatView).
 *
 * A stella conversation does not use this component at all: the server never
 * sends it the model's rows (see components/stella/StellaTranscript.tsx), so
 * there is no flag here to hide them. */
export const ConversationTurn = memo(function ConversationTurn({
  turn,
  entering,
  toolResults,
  runningTools,
  visualBase,
  attachBase,
  running,
  endedAt,
  onRewind,
}: {
  turn: ConversationTurnData;
  /** True when this turn just arrived at the live edge of the transcript, so
   * it may animate in (see hooks/useArrivals). A turn drawn by the first
   * paint or by a page read back must not: the transcript would stage
   * itself, or flash history under the reader. */
  entering: boolean;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
  /** Asset base of the session this turn belongs to (see MarkdownBlock). */
  visualBase: string;
  /** Attachment base of the session (the files chat_attach sent). */
  attachBase: string;
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
      <section
        className="conversation-turn"
        data-enter={entering || undefined}
      >
        {turn.user !== undefined && (
          <MessageRow
            message={turn.user}
            toolResults={toolResults}
            runningTools={runningTools}
            visualBase={visualBase}
          />
        )}
      </section>
    );
  }
  const assistants = turn.responses.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const finalAssistant = assistants.at(-1);
  // The files the agent sent while working on this turn (`chat_attach`
  // results). They render under the reply, always visible: a file the user
  // was handed is part of the answer, not a detail of how it was reached, so
  // it must not hide inside the collapsible work log. The results are read
  // from the turn's own list, so a rewind that drops them drops the card too.
  const attachments = attachmentsOfTurn(turn.responses);
  // Everything the turn produced except the final assistant, whose text
  // renders below the log: intermediate assistant messages (their text and
  // tool calls) plus the turn's compact rows — a notification or a prompt
  // steered into the run. Their relative order is the transcript's; the
  // final assistant's tool calls are appended after them by AssistantTools,
  // which is where they belong. A user message inside the log (a prompt
  // steered into the run) keeps its action row: rewind works on it like on
  // a turn's own prompt.
  const workLog = finalAssistant === undefined
    ? turn.responses
    : turn.responses.filter((message) => message !== finalAssistant);
  const finalToolCalls = finalAssistant?.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  ) ?? [];
  const expandable = workLog.length > 0 || finalToolCalls.length > 0;
  // A fragment (the tail of a turn whose prompt is on an earlier page) has
  // no prompt to time from and nothing to head: its rows ARE the turn's
  // content, so they are drawn open, without an activity header.
  const fragment = turn.user === undefined;
  const startedAt = turn.user?.timestamp ??
    turn.responses[0]?.timestamp ?? 0;
  const lastTimestamp = turn.responses.reduce(
    (latest, message) => Math.max(latest, message.timestamp),
    startedAt,
  );
  const completionTime = endedAt ?? lastTimestamp;

  return (
    <section
      className="conversation-turn"
      data-enter={entering || undefined}
    >
      {turn.user !== undefined && (
        <MessageRow
          message={turn.user}
          toolResults={toolResults}
          runningTools={runningTools}
          visualBase={visualBase}
          onRewind={onRewind}
        />
      )}
      {!fragment && (running || turn.responses.length > 0) && (
        <AgentActivity
          startedAt={startedAt}
          endedAt={running ? undefined : completionTime}
          running={running}
          expanded={running || expanded}
          expandable={!running && expandable}
          onToggle={() => {
            if (!running && expandable) setExpanded((open) => !open);
          }}
        />
      )}
      {
        /* Open while running (the reader watches the work) and while a
         * fragment is drawn (its rows ARE the turn). Both are states the
         * reader did not toggle, but the row still has a height either way,
         * so it goes through the same disclosure. */
      }
      <div className="collapse" data-open={fragment || running || expanded}>
        <div className="collapse-inner">
          <div className="agent-work-log">
            {workLog.map((message, index) => (
              <MessageRow
                key={`${message.timestamp}-${index}`}
                message={message}
                toolResults={toolResults}
                runningTools={runningTools}
                visualBase={visualBase}
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
        </div>
      </div>
      {finalAssistant && contentText(finalAssistant.content) && (
        <AssistantText message={finalAssistant} visualBase={visualBase} />
      )}
      <AttachmentCard attachments={attachments} base={attachBase} />
    </section>
  );
});

/** Every file the turn's `chat_attach` calls sent, in call order. */
function attachmentsOfTurn(
  responses: readonly AgentMessage[],
): AttachmentRef[] {
  const attachments: AttachmentRef[] = [];
  for (const message of responses) {
    if (message.role !== "toolResult") continue;
    if (message.toolName !== TOOL_CHAT_ATTACH || message.isError) continue;
    attachments.push(...attachmentsOfDetails(message.details));
  }
  return attachments;
}
