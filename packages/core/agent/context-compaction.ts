/**
 * Context compaction: keep a long-running conversation inside the model's
 * request limit by inserting one summary checkpoint in front of the history
 * the model no longer needs to see verbatim.
 *
 * The design is pi's (badlogic/pi-mono, packages/coding-agent/src/core/
 * compaction) translated into Lumisca's vocabulary:
 *
 * - **Trigger**: the projected context exceeds `contextWindow -
 *   reserveTokens` (pi's `shouldCompact`), never a fraction of the window.
 * - **Retention**: the newest `keepRecentTokens` tokens stay verbatim; the
 *   cut lands on a unit boundary (an assistant message together with the
 *   tool results that follow it), so a call is never separated from its
 *   result.
 * - **Non-destructive**: nothing is deleted. The checkpoint is INSERTED at
 *   the cut, and the model's view becomes "from the newest checkpoint
 *   onward" (see {@link contextStart}). The transcript, the database and
 *   the UI keep every message.
 * - **Merge**: when a previous checkpoint exists, its summary is carried
 *   into the new one (`<previous-summary>`), so repeated compactions never
 *   drop facts that are still true.
 * - **Summarization request**: the head is serialized to text (tool results
 *   truncated) and sent with a dedicated summarization system prompt — the
 *   session's own prompt and tools are NOT replayed, so the auxiliary
 *   request stays small enough near the window (pi does the same).
 * - **Measurement**: anchored on the provider's own prompt count (see
 *   observeTurn) plus a heuristic for what followed it; a full estimate
 *   only when no turn reported usage yet.
 * - **Failures never destroy history**: a failed summarization leaves the
 *   transcript untouched and the run continues with the history it had.
 */

import type {
  AgentMessage,
  AgentTool,
  Api,
  AssistantMessage,
  LlmMessage,
  Message,
  Model,
  StreamFn,
} from "../ai/types.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { CONTEXT_SAFETY_TOKENS, streamText } from "../ai/stream.ts";
import {
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolTokens,
} from "../shared/token-estimate.ts";
import { contextTokensOf } from "../shared/context-usage.ts";
import { DEFAULT_LOCALE, type Locale, translate } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import {
  COMPACTION_DEFAULT_KEEP_RECENT_TOKENS,
  COMPACTION_DEFAULT_RESERVE_TOKENS,
} from "../shared/settings-keys.ts";
import { toLlmMessages } from "../types/notification.ts";

/** Module logger (debug-gated): every compaction outcome is logged so a
 * session that kept working past its window can be traced. */
const log = createLogger("compaction");

/** The compaction tuning (pi's `CompactionSettings`): whether automatic
 * compaction runs, how much room below the window it leaves for the next
 * request, and how much of the newest history stays verbatim. */
export interface CompactionPolicy {
  enabled: boolean;
  /** Compact once the projected context passes `contextWindow` minus this
   * (pi's `reserveTokens`). It is also the room the summarization request
   * may use for its own output (see CompactionBudgets.summaryMaxTokens). */
  reserveTokens: number;
  /** Newest tokens kept verbatim (pi's `keepRecentTokens`). The cut lands
   * on a unit boundary, so the retained tail is this value rounded up. */
  keepRecentTokens: number;
}

/** pi's defaults (DEFAULT_COMPACTION_SETTINGS). */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  enabled: true,
  reserveTokens: COMPACTION_DEFAULT_RESERVE_TOKENS,
  keepRecentTokens: COMPACTION_DEFAULT_KEEP_RECENT_TOKENS,
};

/** Extra compaction passes per check, each one a summarization call. The
 * second pass only runs while the projection is still over the threshold
 * (pi re-checks on every turn instead; a single check here may need two
 * passes because the retained tail can itself be large). */
const MAX_COMPACTION_ATTEMPTS = 2;

/** Smallest head worth a summarization call. Below this the checkpoint
 * (preamble included) could not free anything meaningful, so the call is
 * not spent. An absolute floor rather than a fraction of the threshold: the
 * manual `/compact` path legitimately condenses below the threshold, where
 * a fraction of it would refuse every useful span. */
const MINIMUM_SPAN_TOKENS = 512;

/** Characters kept per tool result in the serialized conversation (pi's
 * TOOL_RESULT_MAX_CHARS): the full output is not needed to summarize. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** Output floor of the summarization request. Below this a summary could
 * not say anything, so the conversation is trimmed instead of failing. */
const MIN_SUMMARY_TOKENS = 1_024;

/** Fallback output cap of the summarization request when the policy
 * reserves no room (reserveTokens = 0) and the model documents no cap. */
const FALLBACK_SUMMARY_MAX_TOKENS = 8_192;

/** Structural overhead charged for the request envelope (role markers and
 * the tool-calling scaffold around the system prompt). */
const ENVELOPE_OVERHEAD_TOKENS = 32;

/** The checkpoint preamble: tells the model what the block is and that the
 * work continues after it (pi's compaction summary prefix). */
export const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span " +
  "of the conversation to free up context. Treat the captured context as " +
  "established background and build on it without restating it. Continue " +
  "the task directly from the messages that follow, without acknowledging " +
  "this checkpoint.";

/** Tags framing the summary inside the checkpoint body. */
export const CHECKPOINT_SUMMARY_TAG = "compacted-summary";

/** System prompt of the summarization call (pi's
 * SUMMARIZATION_SYSTEM_PROMPT): the auxiliary request must not continue the
 * conversation, and it carries no tools. */
export const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a " +
  "conversation between a user and an AI assistant, then produce a " +
  "structured summary following the exact format specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in " +
  "the conversation. ONLY output the structured summary.";

/** Instruction appended after the serialized conversation on a first
 * compaction (pi's SUMMARIZATION_PROMPT). */
export const SUMMARIZATION_PROMPT =
  `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Instruction used when a previous checkpoint exists: the previous summary
 * is merged instead of being replaced (pi's UPDATE_SUMMARIZATION_PROMPT). */
export const UPDATE_SUMMARIZATION_PROMPT =
  `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** The token budgets one model can actually be asked for. `undefined` when
 * the model documents no window (compaction then stays off: without a
 * capacity there is nothing to measure pressure against) or when the
 * policy disables it. */
export interface CompactionBudgets {
  /** The model's documented window. */
  contextWindow: number;
  /** Compact when the projected context would exceed this
   * (`contextWindow - reserveTokens`). */
  thresholdTokens: number;
  /** Newest tokens kept verbatim. */
  keepRecentTokens: number;
  /** Output cap of the summarization request. */
  summaryMaxTokens: number;
}

/** Resolve the policy from the settings input (see
 * shared/settings-keys.ts): omitted or invalid values keep pi's defaults. */
export function resolveCompactionPolicy(
  input?: CompactionPolicyInput,
): CompactionPolicy {
  return {
    enabled: input?.enabled ?? DEFAULT_COMPACTION_POLICY.enabled,
    reserveTokens: nonNegativeInt(input?.reserveTokens) ??
      DEFAULT_COMPACTION_POLICY.reserveTokens,
    keepRecentTokens: nonNegativeInt(input?.keepRecentTokens) ??
      DEFAULT_COMPACTION_POLICY.keepRecentTokens,
  };
}

function nonNegativeInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Resolve the token budgets of a model: the threshold sits `reserveTokens`
 * below the window, and the summarization call may use at most 80% of that
 * reservation for its own output (pi's `maxTokens`).
 */
export function resolveCompactionBudgets(
  model: Model<Api>,
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionBudgets | undefined {
  if (!policy.enabled) return undefined;
  const window = model.contextWindow;
  if (window === undefined || !Number.isFinite(window) || window <= 0) {
    return undefined;
  }
  const threshold = window - policy.reserveTokens;
  // A reservation as large as the window leaves no room for a prompt:
  // compacting would not make the request acceptable either.
  if (threshold <= 0) return undefined;
  const outputCap = model.maxTokens !== undefined && model.maxTokens > 0
    ? model.maxTokens
    : undefined;
  const summaryMaxTokens = policy.reserveTokens > 0
    ? Math.max(
      1,
      Math.min(
        Math.floor(policy.reserveTokens * 0.8),
        outputCap ?? Number.POSITIVE_INFINITY,
      ),
    )
    : outputCap ?? FALLBACK_SUMMARY_MAX_TOKENS;
  return {
    contextWindow: window,
    thresholdTokens: threshold,
    keepRecentTokens: policy.keepRecentTokens,
    summaryMaxTokens,
  };
}

/** One compaction decision: the head to summarize and where the checkpoint
 * goes. */
export interface CompactionSpan {
  /** 0-based transcript index of the head's first message. */
  start: number;
  /** 0-based transcript index of the first retained message — where the
   * checkpoint is inserted. */
  cutIndex: number;
  /** Number of messages in the head. */
  count: number;
  /** Estimated tokens the head costs the model's view. */
  headTokens: number;
}

/** What one compaction attempt did. */
export interface CompactionResult {
  /** Transcript index the checkpoint now sits at: the model's view starts
   * here. */
  index: number;
  /** The messages the checkpoint summarizes. They stay in the transcript;
   * the model no longer sees them (see contextStart). */
  summarized: AgentMessage[];
  /** Estimated tokens the model's view shrank by. */
  freedTokens: number;
}

/** The collaborators a compactor needs from its host agent. */
export interface ContextCompactorOptions {
  /** The model the session's requests go to: its window sets the budgets,
   * and it writes the summary. */
  model: Model<Api>;
  /** The session's system prompt: priced in the envelope estimate (never
   * replayed in the summarization request — see the module comment). */
  systemPrompt: () => string;
  /** The session's preloaded tools: priced in the envelope estimate. */
  tools: () => readonly AgentTool[];
  streamFn: StreamFn;
  /** The conversation id of the summarization call (session-affinity
   * gateways require it on every request). */
  sessionId: string;
  /** The language of the checkpoint's head line — the language the
   * session's agent was built with (see SessionAgentOptions.language). The
   * summary itself is model output and already follows the session's
   * output-language rule. Omitted → the catalogue's fallback language. */
  language?: Locale;
  /** The compaction tuning read from the settings store. Read on every
   * check, so a settings change applies without rebuilding the agent. */
  policy?: () => CompactionPolicyInput;
  /** Insert the checkpoint at `index` in the durable transcript and in
   * memory. The host owns this write so it can order the two sides
   * (database first: a failed write must leave memory untouched) and keep
   * its own bookkeeping — the persisted-message counter, the
   * context-provider anchors — in step. A throw aborts the compaction with
   * the transcript unchanged. */
  insert: (index: number, message: AgentMessage) => void;
  /** Notify clients that history was condensed (optional: sub-agents have
   * no client surface). */
  onCompacted?: (result: CompactionResult, message: AgentMessage) => void;
}

/** The measurement anchor: the newest provider-reported prompt size, how
 * many projected messages it priced, the projection start at that moment,
 * and the envelope estimate then (so a system-prompt change afterwards is
 * repriced instead of ignored). */
interface MeasurementAnchor {
  /** Prompt tokens the provider reported for that request. */
  tokens: number;
  /** Number of projected messages the prompt covered. */
  length: number;
  /** Estimated system-prompt + tools tokens at the same moment. */
  envelopeTokens: number;
  /** Projection start the measurement was taken under. A different start
   * (a checkpoint was inserted) invalidates the anchor. */
  start: number;
}

/**
 * Condenses one conversation's history. Owned by the agent that runs the
 * conversation (the session agent, or one sub-agent); the transcript itself
 * stays the agent's (`Agent.state.messages`) and is only rewritten through
 * the injected `insert`.
 */
export class ContextCompactor {
  private readonly options: ContextCompactorOptions;
  private anchor?: MeasurementAnchor;
  /** True while a compaction runs: the summarization call itself must not
   * recurse into another compaction. */
  private running = false;

  constructor(options: ContextCompactorOptions) {
    this.options = options;
  }

  /** The policy in effect (settings-backed, pi's defaults otherwise). */
  policy(): CompactionPolicy {
    return resolveCompactionPolicy(this.options.policy?.());
  }

  /** The budgets of the session's model (undefined when the model
   * documents no usable window or the policy disables compaction). */
  budgets(): CompactionBudgets | undefined {
    return resolveCompactionBudgets(this.options.model, this.policy());
  }

  /** Record the newest provider-reported prompt size as the measurement
   * anchor. Called before every measurement, so the anchor tracks the
   * newest request the provider actually priced; the delta the heuristic
   * has to estimate is then only what followed that turn. */
  observeTurn(messages: readonly AgentMessage[]): void {
    const start = contextStart(messages);
    for (let i = messages.length - 1; i >= start; i--) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      const tokens = contextTokensOf((message as AssistantMessage).usage);
      // An outputless failure placeholder reports zeros: it prices nothing,
      // and anchoring on it would understate the next request.
      if (tokens === 0) continue;
      this.anchor = {
        tokens,
        // The provider priced the prompt it received: everything BEFORE
        // this assistant message. What follows it (the message itself and
        // its tool results) is the estimated delta.
        length: i - start,
        envelopeTokens: this.envelopeTokens(),
        start,
      };
      return;
    }
  }

  /** Estimated tokens of the request envelope: the system prompt and the
   * tool schemas. */
  private envelopeTokens(): number {
    return estimateTextTokens(this.options.systemPrompt()) +
      ENVELOPE_OVERHEAD_TOKENS +
      this.options.tools().reduce(
        (sum, tool) => sum + estimateToolTokens(tool),
        0,
      );
  }

  /** Estimated tokens of the model's view: the anchored provider figure
   * plus everything appended since, or a full estimate when no anchor
   * applies (no turn reported usage, or the projection moved under it). */
  measure(messages: readonly AgentMessage[]): number {
    const start = contextStart(messages);
    const anchor = this.anchor;
    if (
      anchor !== undefined && anchor.start === start &&
      anchor.length <= messages.length - start
    ) {
      return anchor.tokens +
        (this.envelopeTokens() - anchor.envelopeTokens) +
        estimateMessagesTokensFrom(messages, start + anchor.length);
    }
    return this.envelopeTokens() + estimateMessagesTokensFrom(messages, start);
  }

  /**
   * Condense the transcript when pressure requires it. `force` skips the
   * threshold and retention policy and reduces the history as far as one
   * balanced span allows — the overflow recovery path (a provider-confirmed
   * window rejection), where waiting for the next threshold is not an
   * option. `instructions` is the user's extra focus for the summary (the
   * `/compact <instructions>` path).
   *
   * Returns the result, or null when nothing had to (or could) be done. A
   * failed summarization is not an exception for the caller: the transcript
   * is left untouched and the run continues with the history it had.
   */
  async compactIfNeeded(
    messages: AgentMessage[],
    options: { force?: boolean; instructions?: string } = {},
  ): Promise<CompactionResult | null> {
    if (this.running) return null;
    const budgets = this.budgets();
    if (budgets === undefined) return null;
    const force = options.force === true;
    this.observeTurn(messages);
    if (!force) {
      const measured = this.measure(messages);
      if (measured <= budgets.thresholdTokens) return null;
      // The envelope alone (system prompt + tool schemas) is over the
      // threshold: replacing history cannot bring the request under it, so
      // a summarization call would be spent for nothing.
      if (this.envelopeTokens() >= budgets.thresholdTokens) return null;
    }
    let last: CompactionResult | null = null;
    let previous = this.measure(messages);
    for (let attempt = 0; attempt < MAX_COMPACTION_ATTEMPTS; attempt++) {
      const result = await this.runOnce(messages, force, options.instructions);
      if (result === null) return last;
      last = result;
      if (force) continue;
      // Stop as soon as the next request fits again: one span is usually
      // enough, and each extra attempt costs another summarization call.
      const measured = this.measure(messages);
      if (measured <= budgets.thresholdTokens) return result;
      // A replacement that did not move the measurement cannot be improved
      // by another one (the remaining span is what it is): stop instead of
      // paying for a second call that would free nothing.
      if (measured >= previous) return result;
      previous = measured;
    }
    return last;
  }

  /** Condense one useful span even below the pressure threshold (the manual
   * `/compact` path). Returns null when no safe span exists. */
  async compactNow(
    messages: AgentMessage[],
    instructions?: string,
  ): Promise<CompactionResult | null> {
    if (this.running) return null;
    this.observeTurn(messages);
    return await this.runOnce(messages, false, instructions);
  }

  /** One compaction transaction: select the head, summarize it, and commit
   * the checkpoint. */
  private async runOnce(
    messages: AgentMessage[],
    force: boolean,
    instructions?: string,
  ): Promise<CompactionResult | null> {
    const budgets = this.budgets();
    if (budgets === undefined) return null;
    const span = selectCompactionSpan(
      messages,
      contextStart(messages),
      budgets,
      force,
    );
    if (span === null) return null;
    const head = messages.slice(span.start, span.cutIndex);
    // A previous checkpoint is not replayed as a message: its summary is
    // merged into the new one (pi's UPDATE_SUMMARIZATION_PROMPT).
    const previous = head[0]?.role === "checkpoint"
      ? checkpointSummaryText(head[0])
      : undefined;
    const source = previous === undefined ? head : head.slice(1);
    this.running = true;
    let summary: string;
    try {
      summary = await this.summarize(source, previous, instructions, budgets);
    } catch (error) {
      // Nothing was rewritten: the transcript keeps the history it had, and
      // the run continues with it.
      log.warn(
        `session ${this.options.sessionId}: compaction failed: ${
          errorMessage(error)
        }`,
      );
      return null;
    } finally {
      this.running = false;
    }
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
      log.warn(
        `session ${this.options.sessionId}: compaction produced no summary`,
      );
      return null;
    }
    const checkpoint = checkpointMessage(
      head.length,
      span.headTokens,
      trimmed,
      this.options.language ?? DEFAULT_LOCALE,
    );
    // A summary that does not shrink the view would make the request
    // bigger: refuse it rather than pay for the insertion.
    if (estimateMessageTokens(checkpoint) >= span.headTokens) {
      log.warn(
        `session ${this.options.sessionId}: compaction summary did not ` +
          `shrink its source (${span.headTokens} tokens)`,
      );
      return null;
    }
    // The host performs the insertion (durable first). A throw leaves the
    // transcript exactly as it was: nothing to roll back here.
    this.options.insert(span.cutIndex, checkpoint);
    this.anchor = undefined;
    const result: CompactionResult = {
      index: span.cutIndex,
      summarized: head,
      freedTokens: span.headTokens - estimateMessageTokens(checkpoint),
    };
    log.debug(
      `session ${this.options.sessionId}: compacted ${head.length} messages ` +
        `(~${result.freedTokens} tokens freed)`,
    );
    this.options.onCompacted?.(result, checkpoint);
    return result;
  }

  /**
   * Write the summary for one head: the head is serialized to text (tool
   * results truncated) and sent with a dedicated summarization system
   * prompt, so the model summarizes instead of continuing the conversation.
   * The session's own system prompt and tools are deliberately not part of
   * the request: the head already sits near the window, and the auxiliary
   * request must leave room for its own output (pi does the same).
   */
  private async summarize(
    head: readonly AgentMessage[],
    previous: string | undefined,
    instructions: string | undefined,
    budgets: CompactionBudgets,
  ): Promise<string> {
    const prompt = buildSummarizationPrompt(
      head,
      previous,
      instructions,
      budgets,
      this.options.sessionId,
    );
    const request = {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }] as LlmMessage[],
    };
    return await streamText(
      this.options.streamFn,
      this.options.model,
      request,
      "compaction summarization failed",
      {
        sessionId: this.options.sessionId,
        maxOutputTokens: budgets.summaryMaxTokens,
      },
    );
  }
}

/** Build the checkpoint message: the preamble, the framed summary, and the
 * head line the UI shows. The title never reaches the model — the body
 * carries the model-facing text. */
export function checkpointMessage(
  summarizedCount: number,
  summarizedTokens: number,
  summary: string,
  language: Locale = DEFAULT_LOCALE,
): AgentMessage {
  return {
    role: "checkpoint",
    title: translate(language, "checkpoint.title", {
      count: summarizedCount,
      tokens: formatTokenCount(summarizedTokens),
    }),
    body:
      `${CHECKPOINT_PREAMBLE}\n\n<${CHECKPOINT_SUMMARY_TAG}>\n${summary}\n</${CHECKPOINT_SUMMARY_TAG}>`,
    timestamp: Date.now(),
  } as AgentMessage;
}

/** The summary text of a checkpoint (the body minus the preamble and the
 * framing tags), used as `<previous-summary>` on the next compaction. */
export function checkpointSummaryText(message: AgentMessage): string {
  const body = (message as { body?: unknown }).body;
  if (typeof body !== "string") return "";
  const open = `<${CHECKPOINT_SUMMARY_TAG}>`;
  const close = `</${CHECKPOINT_SUMMARY_TAG}>`;
  const start = body.indexOf(open);
  const end = body.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) return body.trim();
  return body.slice(start + open.length, end).trim();
}

/** Compact token count for the checkpoint title ("12K"). */
function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const k = Math.round(value / 100) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return String(value);
}

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
function buildSummarizationPrompt(
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
function estimateMessagesTokensFrom(
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
interface TranscriptUnit {
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
