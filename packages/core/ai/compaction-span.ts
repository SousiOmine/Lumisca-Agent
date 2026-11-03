/**
 * Reading a transcript for compaction: which messages the model still sees,
 * how they are serialized for the summarizer, and where the cut goes.
 *
 * These are pure functions over a transcript — no model call, no store — and
 * they answer one question: "what would a checkpoint replace?". Kept apart
 * from the compactor itself (which decides WHEN and performs the call) so
 * that question can be read, and tested, without a model in sight.
 */
import type { AgentMessage, Message } from "./types.ts";
import { CONTEXT_SAFETY_TOKENS } from "./budget.ts";
import { createLogger } from "../log.ts";
import {
  estimateMessageTokens,
  estimateTextTokens,
} from "../shared/token-estimate.ts";
import { toLlmMessages } from "../types/notification.ts";
import type { CompactionBudgets } from "./compaction-policy.ts";
import {
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./compaction-prompts.ts";

const log = createLogger("compaction");

/** One compaction decision: the head to summarize and where the checkpoint
 * goes. */
export interface CompactionSpan {
  /** 0-based transcript index of the head's first message. */
  start: number;
  /** 0-based transcript index of the first retained message, where the
   * checkpoint is inserted. */
  cutIndex: number;
  /** Number of messages in the head. */
  count: number;
  /** Estimated tokens the head costs the model's view. */
  headTokens: number;
}
/** Output floor of the summarization request (see buildSummarizationPrompt). */
const MIN_SUMMARY_TOKENS = 1_024;

/** Characters kept per tool result in the serialized conversation (pi's
 * TOOL_RESULT_MAX_CHARS): the full output is not needed to summarize. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** Smallest head worth a summarization call (see selectCompactionSpan). */
const MINIMUM_SPAN_TOKENS = 512;

/** Structural view of an LLM content block (the serializer only reads
 * text, thinking, images, and tool calls). */
interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

/** Text of one message's content, with images marked so the summary can
 * still mention that something was attached. */
function contentText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as ContentBlockLike;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[Attached image]");
    }
  }
  return parts.join("\n");
}

/** Truncate a tool result for the serialized conversation (pi's
 * truncateForSummary). */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.length - maxChars;
  return `${
    text.slice(0, maxChars)
  }\n\n[... ${truncated} more characters truncated]`;
}

/** Serialize one LLM message into the `[Role]: text` shape pi uses. */
function serializeMessage(message: Message): string | undefined {
  if (message.role === "user") {
    const text = contentText(message.content);
    return text.trim().length > 0 ? `[User]: ${text}` : undefined;
  }
  if (message.role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const thinking: string[] = [];
    const calls: string[] = [];
    for (const raw of blocks) {
      const block = raw as ContentBlockLike;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        thinking.push(block.thinking);
      } else if (block.type === "toolCall") {
        calls.push(`${block.name}(${JSON.stringify(block.arguments)})`);
      }
    }
    const text = contentText(message.content);
    const parts: string[] = [];
    if (thinking.length > 0) {
      parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
    }
    if (text.trim().length > 0) parts.push(`[Assistant]: ${text}`);
    if (calls.length > 0) {
      parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (message.role === "toolResult") {
    const text = contentText(message.content);
    if (text.trim().length === 0) return undefined;
    const label = message.isError ? "Tool error" : "Tool result";
    return `[${label}]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`;
  }
  return undefined;
}

/** Serialize the head, one part per message (empty messages are skipped). */
function serializeHead(head: readonly AgentMessage[]): string[] {
  const parts: string[] = [];
  for (const message of toLlmMessages([...head])) {
    const part = serializeMessage(message);
    if (part !== undefined) parts.push(part);
  }
  return parts;
}

/**
 * Build the summarization prompt: the serialized head inside
 * `<conversation>` tags, the previous summary (when there is one), and the
 * instruction. The oldest parts are dropped when the request would not
 * leave room for the summary itself — pi relies on its overflow retry here,
 * but the late threshold means the head routinely sits near the window, so
 * the request is trimmed instead of failing.
 */
export function buildSummarizationPrompt(
  head: readonly AgentMessage[],
  previous: string | undefined,
  instructions: string | undefined,
  budgets: CompactionBudgets,
  sessionId: string,
): string {
  const instruction = previous === undefined
    ? SUMMARIZATION_PROMPT
    : UPDATE_SUMMARIZATION_PROMPT;
  const focus = instructions?.trim();
  let skeleton = previous === undefined
    ? ""
    : `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
  skeleton += instruction;
  if (focus !== undefined && focus.length > 0) {
    skeleton += `\n\nAdditional focus: ${focus}`;
  }
  const budget = budgets.contextWindow - CONTEXT_SAFETY_TOKENS -
    MIN_SUMMARY_TOKENS - estimateTextTokens(skeleton);
  const parts = serializeHead(head);
  let total = parts.reduce((sum, part) => sum + estimateTextTokens(part), 0);
  let from = 0;
  while (from < parts.length - 1 && total > budget) {
    total -= estimateTextTokens(parts[from]!);
    from++;
  }
  if (from > 0) {
    log.debug(
      `session ${sessionId}: compaction request trimmed ${from} older ` +
        `messages to fit the window`,
    );
  }
  const conversation = parts.slice(from).join("\n\n");
  return `<conversation>\n${conversation}\n</conversation>\n\n${skeleton}`;
}

/** Estimated tokens of `messages` from `from` on (avoids the array copy a
 * `slice` would allocate on every measurement). */
export function estimateMessagesTokensFrom(
  messages: readonly AgentMessage[],
  from: number,
): number {
  let tokens = 0;
  for (let i = from; i < messages.length; i++) {
    tokens += estimateMessageTokens(messages[i]!);
  }
  return tokens;
}

/** The start of the model's view: the newest checkpoint, or 0 when the
 * conversation was never compacted. Everything before it stays in the
 * transcript but is not sent to the model. */
export function contextStart(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "checkpoint") return i;
  }
  return 0;
}

/** One transcript unit: a message together with the tool results that
 * belong to it. A unit boundary is the only safe cut — an assistant message
 * carrying tool calls must never be separated from its results (providers
 * reject a request with an unanswered call). */
export interface TranscriptUnit {
  /** 0-based index of the unit's first message. */
  index: number;
  /** Number of messages in the unit. */
  count: number;
  /** Estimated tokens of the unit. */
  tokens: number;
}

/** Split the transcript from `from` on into compaction units: an assistant
 * message together with the tool results directly following it, or a single
 * message. */
export function transcriptUnits(
  messages: readonly AgentMessage[],
  from = 0,
): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  for (let i = from; i < messages.length;) {
    const message = messages[i]!;
    let count = 1;
    if (message.role === "assistant") {
      while (
        i + count < messages.length &&
        messages[i + count]!.role === "toolResult"
      ) {
        count++;
      }
    }
    let tokens = 0;
    for (let j = i; j < i + count; j++) {
      tokens += estimateMessageTokens(messages[j]!);
    }
    units.push({ index: i, count, tokens });
    i += count;
  }
  return units;
}

/**
 * Select the head to summarize: the oldest units of the model's view,
 * stopping where the retained tail reaches its token budget. The newest unit
 * is always retained, so a compaction can never remove the work in
 * progress — the model must keep answering the most recent request.
 *
 * `force` ignores the retention budget and reduces as far as one span can
 * (still keeping the newest unit) — the overflow recovery path, where the
 * alternative is a request the provider already rejected.
 *
 * Two spans are refused in every mode, because summarizing them would churn
 * checkpoints without reducing a request:
 *
 * - one that holds nothing but an earlier checkpoint (a previous compaction
 *   that already covered everything up to the retained tail), and
 * - one too small to free anything (below {@link MINIMUM_SPAN_TOKENS}).
 */
export function selectCompactionSpan(
  messages: readonly AgentMessage[],
  start: number,
  budgets: CompactionBudgets,
  force = false,
): CompactionSpan | null {
  const units = transcriptUnits(messages, start);
  if (units.length < 2) return null;
  // Walk the tail backwards: keep the newest unit, then extend while the
  // retention budget is not met. Everything before the cut is summarized.
  let cutUnit = units.length - 1;
  let retainedTokens = units[cutUnit]!.tokens;
  while (!force && cutUnit > 0 && retainedTokens < budgets.keepRecentTokens) {
    cutUnit--;
    retainedTokens += units[cutUnit]!.tokens;
  }
  if (cutUnit <= 0) return null;
  const first = units[0]!;
  const cut = units[cutUnit]!;
  let headTokens = 0;
  for (let i = 0; i < cutUnit; i++) headTokens += units[i]!.tokens;
  let hasSourceMessage = false;
  for (let i = first.index; i < cut.index; i++) {
    if (messages[i]!.role !== "checkpoint") {
      hasSourceMessage = true;
      break;
    }
  }
  if (!hasSourceMessage) return null;
  if (headTokens < MINIMUM_SPAN_TOKENS) return null;
  const count = cut.index - first.index;
  if (count <= 0) return null;
  return {
    start: first.index,
    cutIndex: cut.index,
    count,
    headTokens,
  };
}
