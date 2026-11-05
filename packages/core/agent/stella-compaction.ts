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
 */
import type { AgentMessage } from "../ai/types.ts";
import type { CompactionStyle } from "../ai/compaction-style.ts";
import { formatLocalDateTime } from "../shared/misc.ts";
import { stellaEntryText } from "../session/history.ts";
import { stellaEntryOf } from "./stella-stream.ts";

/** Output cap of the record. The prompt asks for at most 30 short lines;
 * this is the backstop, not the target. */
export const STELLA_RECORD_MAX_TOKENS = 4_000;

/** System prompt of the record call. */
export const STELLA_RECORD_SYSTEM_PROMPT =
  "You maintain the long-term record of a conversation between a user and " +
  "an assistant. The record is the conversation's current state, not a " +
  "transcript. Do not continue the conversation. Output only the record in " +
  "the requested format.";

/** The record instruction: rewrite in full, state only, dates only when they
 * are a fact about the present or the future. */
export const STELLA_RECORD_PROMPT =
  `The <conversation> above is the conversation since the last record: the user's messages and the assistant's replies, each headed with its local date and time. Tool calls and their output are not part of the conversation; what the assistant sent with send_chat (cards, files, progress messages) is.

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
- Do not record tool output, commands, or step-by-step work.
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

export const STELLA_COMPACTION_STYLE: CompactionStyle = {
  systemPrompt: STELLA_RECORD_SYSTEM_PROMPT,
  serialize: (head) =>
    head.flatMap((message) => {
      const part = recordPart(message);
      return part === undefined ? [] : [part];
    }),
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
