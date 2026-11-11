/**
 * How a compaction turns the head into the request the summarizer reads, and
 * what it asks for.
 *
 * Two styles exist because the two kinds of session remember different
 * things. A code session's history is a work log: the goal, the progress,
 * the tool output that explains a failure. A stella conversation's history
 * is the conversation itself: what the user and the agent said, while the
 * tool traffic stays on the machine and the conversation can be searched
 * (see session/history.ts). The mechanism is the same; only the text, the
 * instruction and the checkpoint's preamble differ.
 */

import type { CompactionBudgets } from "./compaction-policy.ts";
import {
  CHECKPOINT_PREAMBLE,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./compaction-prompts.ts";
import { serializeHead } from "./compaction-span.ts";
import type { AgentMessage } from "./types.ts";

export interface CompactionStyle {
  /** System prompt of the summarization call. */
  systemPrompt: string;
  /** The head as text parts, one per message. The request builder drops the
   * oldest parts when the whole head would not leave room for the summary. */
  serialize: (
    head: readonly AgentMessage[],
    previous: string | undefined,
  ) => string[];
  /** The instruction appended after the conversation. `previous` is the
   * summary of the checkpoint at the head's start, when there is one. */
  prompt: (previous: string | undefined) => string;
  /** Output cap of the summarization call. */
  maxTokens: (budgets: CompactionBudgets) => number;
  /** Model-facing preamble of the checkpoint the summary becomes. */
  preamble: string;
}

/** The work-log style: a code session's history, summarized as the state of
 * the task (goal, progress, decisions, next steps). */
export const WORK_COMPACTION_STYLE: CompactionStyle = {
  systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
  // The checkpoint is not replayed as a message: its summary travels in
  // `<previous-summary>` instead (pi's update prompt).
  serialize: (head, previous) =>
    serializeHead(previous === undefined ? head : head.slice(1)),
  prompt: (previous) =>
    previous === undefined
      ? SUMMARIZATION_PROMPT
      : `<previous-summary>\n${previous}\n</previous-summary>\n\n` +
        UPDATE_SUMMARIZATION_PROMPT,
  maxTokens: (budgets) => budgets.summaryMaxTokens,
  preamble: CHECKPOINT_PREAMBLE,
};
