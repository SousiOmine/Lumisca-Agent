/**
 * The stella compaction style: the record of a long conversation, not a work
 * log.
 *
 * A stella conversation lives for weeks and is condensed while it is idle
 * (see SessionAgentOptions.idleCompaction). What it needs to keep is the
 * conversation's current state — what the user wants, what was decided, what
 * is still open — not a transcript: the conversation itself can be searched
 * with history_search, by word or by date, and the tool traffic stays on the
 * machine. So the summary is built from the same projection the conversation
 * and the search use (stellaEntryOf), rewritten in full each time, and capped
 * small.
 *
 * One thing the conversation does not show still matters to the record: that
 * work happened. A span of tool calls that leaves no trace in the record
 * reads as "nothing was done yet", and the model then redoes it. So each run
 * of tool calls adds one `[tools]` line where the run sits — names and counts
 * only, never arguments or output (see toolsLine). It is an extra part of the
 * serialization, not part of the projection: what the conversation shows is
 * still stellaEntryOf's answer alone.
 */
import type { AgentMessage } from "../ai/types.ts";
import type { CompactionStyle } from "../ai/compaction-style.ts";
import { formatLocalDateTime } from "../shared/misc.ts";
import { TOOL_SEND_CHAT } from "../shared/tool-names.ts";
import { stellaEntryText } from "../session/history.ts";
import { stellaEntryOf } from "./stella-stream.ts";

/** Output cap of the record. The prompt asks for at most 30 short lines;
 * this is the backstop, not the target. */
export const STELLA_RECORD_MAX_TOKENS = 4_000;

export const STELLA_RECORD_SYSTEM_PROMPT =
  "You maintain the long-term record of a conversation between a user and " +
  "an assistant. The record is the conversation's current state, not a " +
  "transcript. Do not continue the conversation. Output only the record in " +
  "the requested format.";

/** The record instruction: rewrite in full, state only, dates only when they
 * are a fact about the present or the future. */
export const STELLA_RECORD_PROMPT =
  `The <conversation> above is the conversation since the last record: the user's messages and the assistant's replies, each headed with its local date and time. A line beginning with [tools] may sit between them; it names the tools that ran at that point and how often, with no arguments and no output. What the assistant sent with send_chat (cards, files, progress messages) is part of the conversation.

Write the conversation's record. If a <previous-record> is above, rewrite it in full together with the new messages: do not append to it and do not preserve its wording. Keep what is still true, drop what is superseded, merge related items, and add what the new messages established.

The record is the conversation's current state, not its history. The conversation itself can be searched later with history_search, by word or by date, so the record does not need to reproduce events or their dates.

Use this EXACT format:

## Now
- [What is happening now, what the user wants, stable preferences, and decisions still in force]
- [A deadline or scheduled event that is still ahead belongs here, with its absolute date]

## Open
- [Anything unresolved, waiting, or blocked]
- [Or "(none)" if nothing is open]

Rules:
- Keep each line short. At most 30 lines in total.
- Write an absolute date only when it is a fact about the present or the future (a deadline, an appointment, a schedule). Do not date past events.
- Do not record tool output, commands, arguments, or step-by-step work. A [tools] line is not to be copied: use it only to know what work was already done, and never write its counts into the record.
- Do not invent. If something is uncertain, say so.`;

/** Model-facing preamble of the checkpoint. */
export const STELLA_CHECKPOINT_PREAMBLE =
  "This is a short record of the conversation so far, kept in place of the " +
  "turns that were condensed away. It is not a transcript: the conversation " +
  "itself can be searched with history_search, by word or by date. Treat " +
  "the record as the current state and continue from the messages that " +
  "follow without acknowledging it.";

/** One transcript message as a record part, or undefined when the message is
 * not part of the conversation (tool traffic, context, notifications, the
 * checkpoint itself — the previous record travels in `<previous-record>`). */
function recordPart(message: AgentMessage): string | undefined {
  const entry = stellaEntryOf(message);
  if (entry === null) return undefined;
  const who = entry.role === "user" ? "User" : "Assistant";
  return `[${formatLocalDateTime(entry.timestamp)}] ${who}\n${
    stellaEntryText(entry)
  }`;
}

/** Tools whose calls are the conversation itself: a `send_chat` result is
 * already projected as the message it sent, so naming it in a `[tools]` line
 * would say nothing. */
const UNTALLIED_TOOLS: ReadonlySet<string> = new Set([TOOL_SEND_CHAT]);

/** Distinct tools one line names. A machine with many MCP servers can call
 * dozens; the line stays one line and the tail becomes "+N more". */
const TOOL_LINE_LIMIT = 12;

/** How many times one tool ran in a run, and how many of those failed. */
interface ToolUse {
  calls: number;
  failed: number;
}

/** Count one message's tool calls into the run being accumulated. The call is
 * the unit (`bash ×3` means three calls, not three results); the failures come
 * from the results that follow. */
function countTools(
  message: AgentMessage,
  pending: Map<string, ToolUse>,
): void {
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type !== "toolCall" || UNTALLIED_TOOLS.has(block.name)) {
        continue;
      }
      const use = pending.get(block.name);
      if (use === undefined) pending.set(block.name, { calls: 1, failed: 0 });
      else use.calls++;
    }
    return;
  }
  if (message.role !== "toolResult" || !message.isError) return;
  if (UNTALLIED_TOOLS.has(message.toolName)) return;
  // A failed result whose call is not in this run is not a call of this run
  // (the head starts at a unit boundary, so it cannot happen); a result whose
  // call is here only marks that call as failed.
  const use = pending.get(message.toolName);
  if (use !== undefined) use.failed++;
}

/** The `[tools]` line of one run: names and counts only, most-used first, and
 * the name as the tie-break so the same run always serializes the same way.
 * Undefined when the run called nothing worth naming. */
function toolsLine(
  pending: ReadonlyMap<string, ToolUse>,
): string | undefined {
  if (pending.size === 0) return undefined;
  const sorted = [...pending.entries()].sort((a, b) =>
    b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const shown = sorted.slice(0, TOOL_LINE_LIMIT).map(([name, use]) =>
    use.failed > 0
      ? `${name} ×${use.calls} (${use.failed} failed)`
      : `${name} ×${use.calls}`
  );
  const hidden = sorted.length - shown.length;
  return `[tools] ${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

/** The head as record parts: the conversation in order, with one `[tools]`
 * line per run of tool calls, placed where the run happened — before the
 * message that follows it. A run with nothing conversational after it (the
 * span ends in tool work) still gets its line, at the end: dropping it would
 * hide work the record is meant to know about. */
function recordParts(head: readonly AgentMessage[]): string[] {
  const parts: string[] = [];
  let pending = new Map<string, ToolUse>();
  const flush = (): void => {
    const line = toolsLine(pending);
    if (line !== undefined) parts.push(line);
    pending = new Map();
  };
  for (const message of head) {
    const part = recordPart(message);
    if (part !== undefined) {
      flush();
      parts.push(part);
    }
    countTools(message, pending);
  }
  flush();
  return parts;
}

export const STELLA_COMPACTION_STYLE: CompactionStyle = {
  systemPrompt: STELLA_RECORD_SYSTEM_PROMPT,
  serialize: (head) => recordParts(head),
  prompt: (previous) =>
    previous === undefined
      ? STELLA_RECORD_PROMPT
      : `<previous-record>\n${previous}\n</previous-record>\n\n` +
        STELLA_RECORD_PROMPT,
  // Never ask for more output than the session's model can produce; the
  // record's own cap is the smaller of the two.
  maxTokens: (budgets) =>
    Math.min(STELLA_RECORD_MAX_TOKENS, budgets.summaryMaxTokens),
  preamble: STELLA_CHECKPOINT_PREAMBLE,
};
