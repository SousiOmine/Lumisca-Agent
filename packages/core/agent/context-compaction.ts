/**
 * Context compaction: keep a long-running conversation inside the model's
 * request limit by replacing its oldest span with one summary checkpoint.
 *
 * The design follows the DeepSeek Harness's compaction seam and token
 * meter, translated into Lumisca's vocabulary:
 *
 * - **Measurement anchored on provider usage.** A request is priced from
 *   the newest assistant `usage` — the provider's own token count for the
 *   prompt it received — plus a fixed heuristic for what was appended
 *   after it (`shared/token-estimate.ts`). Only when no turn reported
 *   usage yet is the whole envelope estimated.
 * - **A budget derived from what a request may actually carry.** Providers
 *   reject `prompt + maxOutputTokens` against the window (the reported
 *   failure: 665,871 prompt tokens plus the 384,000 reserved completion
 *   against 1,048,576), so the threshold is a fraction of
 *   `contextWindow - outputCap`, never of the window itself.
 * - **Pressure at the step boundary.** The check runs before every LLM
 *   request of a run (`Agent.beforeStep`), so a tool-heavy turn cannot grow
 *   past the window mid-turn — the same reason DSH checks at
 *   `agent/pre-step` after every successful step.
 * - **Replacement, not append.** The selected span is replaced in place by
 *   one checkpoint message, so the model reads "checkpoint → retained
 *   recent messages" instead of a second copy of the history.
 * - **Summarization replays the request.** The auxiliary call sends the
 *   session's own system prompt, tool schemas, and the selected span
 *   verbatim, then the instruction as the final user message, so the
 *   provider's warm prefix cache covers everything but the instruction.
 * - **Failures never destroy history.** A failed summarization leaves the
 *   transcript untouched (the run then continues with the over-budget
 *   history, exactly as it would have without compaction) and the original
 *   provider error is never swallowed.
 */

import type {
  AgentMessage,
  AgentTool,
  Api,
  AssistantMessage,
  CheckpointMessage,
  LlmMessage,
  Model,
  StreamFn,
} from "../ai/types.ts";
import { CoreError, errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { streamText } from "../ai/stream.ts";
import {
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolTokens,
} from "../shared/token-estimate.ts";
import { contextTokensOf } from "../shared/context-usage.ts";
import { toLlmMessages } from "../types/notification.ts";

/** Module logger (debug-gated): every compaction outcome is logged so a
 * session that kept working past its window can be traced. */
const log = createLogger("compaction");

/** Start compacting at this fraction of the usable input budget (DSH's
 * `thresholdRatio` default). */
const DEFAULT_THRESHOLD_RATIO = 0.8;

/** Keep the newest messages verbatim until they fill this fraction of the
 * usable input budget (DSH's `retainRatio` default). */
const DEFAULT_RETAIN_RATIO = 0.16;

/** Extra compaction attempts when the first one did not restore safe
 * pressure (DSH's `compactionRetries` default). */
const DEFAULT_COMPACTION_RETRIES = 1;

/** Output cap of the summarization call. Bounded because the auxiliary
 * request itself must fit the window it is trying to free (DSH's
 * `maxTokens` default). */
const DEFAULT_SUMMARIZATION_MAX_TOKENS = 8192;

/** Structural overhead charged for the request envelope (role markers and
 * the tool-calling scaffold around the system prompt). */
const ENVELOPE_OVERHEAD_TOKENS = 32;

/** The checkpoint preamble: tells the model what the block is and that the
 * work continues after it (DSH's checkpoint preamble). */
export const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span " +
  "of the conversation to free up context. Treat the captured context as " +
  "established background and build on it without restating it. Continue " +
  "the task directly from the messages that follow, without acknowledging " +
  "this checkpoint.";

/** Tags framing the summary inside the checkpoint body. */
export const CHECKPOINT_SUMMARY_TAG = "compacted-summary";

/** The instruction appended as the final user message of the summarization
 * request. The section structure is the DeepSeek Harness's: a fixed
 * Markdown skeleton keeps checkpoints comparable between cycles and forces
 * the summarizer to state what is still pending instead of retelling the
 * conversation. */
export const COMPACTION_INSTRUCTION =
  `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <${CHECKPOINT_SUMMARY_TAG}> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`;

/** Trigger policy of the compactor: the ratios and caps that decide when a
 * conversation is condensed. Resolved from the session's model, so a small
 * window compacts early and a large one late. */
export interface CompactionPolicy {
  /** Start compacting at this fraction of the usable input budget. */
  thresholdRatio: number;
  /** Fraction of the usable input budget kept verbatim at the tail. */
  retainRatio: number;
  /** Extra attempts when the first compaction did not restore pressure. */
  compactionRetries: number;
  /** Output cap of the summarization request. */
  summarizationMaxTokens: number;
}

/** The default policy (see the constants above). */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  compactionRetries: DEFAULT_COMPACTION_RETRIES,
  summarizationMaxTokens: DEFAULT_SUMMARIZATION_MAX_TOKENS,
};

/** The token budgets one model can actually be asked for: the window minus
 * the completion the request reserves, and the thresholds derived from it.
 * `undefined` when the model documents no window — without a capacity there
 * is nothing to measure pressure against, so compaction stays off (DSH
 * behaves the same way: an adapter reporting no capacity disables the
 * automatic pressure path). */
export interface CompactionBudgets {
  /** `contextWindow - outputCap`: the widest prompt the provider accepts. */
  usableInputTokens: number;
  /** Compact when the next request would exceed this. */
  thresholdTokens: number;
  /** Tail kept verbatim (a lower bound per unit, not a hard cut). */
  retainTokens: number;
  /** Completion reserved by every request (0 when the model documents no
   * output cap). */
  outputCapTokens: number;
}

/** Resolve the policy of a model. The policy is a function of the model
 * alone today; a settings-backed override has this one place to land. */
export function resolveCompactionPolicy(
  _model: Model<Api>,
): CompactionPolicy {
  return DEFAULT_COMPACTION_POLICY;
}

/**
 * Resolve the token budgets of a model. The completion reserve matters:
 * providers validate `prompt + maxOutputTokens` against the window, so a
 * model reserving a 384,000-token completion can only carry
 * `window - 384,000` prompt tokens however large the window is.
 */
export function resolveCompactionBudgets(
  model: Model<Api>,
  policy: CompactionPolicy = resolveCompactionPolicy(model),
): CompactionBudgets | undefined {
  const window = model.contextWindow;
  if (window === undefined || !Number.isFinite(window) || window <= 0) {
    return undefined;
  }
  const outputCap = model.maxTokens !== undefined && model.maxTokens > 0
    ? model.maxTokens
    : 0;
  const usable = window - outputCap;
  // A model whose completion reserve leaves no room for a prompt cannot be
  // budgeted: compacting would not make the request acceptable either.
  if (usable <= 0) return undefined;
  const threshold = Math.floor(usable * policy.thresholdRatio);
  // The retained tail never fills the whole threshold: a compaction must
  // leave headroom for the messages that follow it.
  const retain = Math.min(
    Math.floor(usable * policy.retainRatio),
    Math.floor(threshold / 2),
  );
  return {
    usableInputTokens: usable,
    thresholdTokens: threshold,
    retainTokens: retain,
    outputCapTokens: outputCap,
  };
}

/** One compaction decision: the span to replace and its estimated cost. */
export interface CompactionSpan {
  /** 0-based transcript index of the first replaced message. */
  index: number;
  /** Number of messages replaced. */
  count: number;
  /** Tokens the replaced span is estimated to cost. */
  replacedTokens: number;
}

/** What one compaction attempt did. */
export interface CompactionResult {
  /** 0-based transcript index the checkpoint now sits at. */
  index: number;
  /** The messages that were replaced. */
  removed: AgentMessage[];
  /** Estimated tokens freed (replaced span minus the checkpoint). */
  freedTokens: number;
}

/** The collaborators a compactor needs from its host agent. */
export interface ContextCompactorOptions {
  /** The model the session's requests go to: its window and output cap set
   * the budgets, and it writes the summary. */
  model: Model<Api>;
  /** The session's system prompt: replayed in the summarization request so
   * the provider's prefix cache covers it. */
  systemPrompt: () => string;
  /** The session's preloaded tools: replayed as schemas (never executed) in
   * the summarization request, and priced when the envelope is estimated. */
  tools: () => readonly AgentTool[];
  streamFn: StreamFn;
  /** The conversation id of the summarization call (session-affinity
   * gateways require it on every request). */
  sessionId: string;
  /** Replace `count` messages from `index` with `message` in the durable
   * transcript and in memory. The host owns this write so it can order the
   * two sides (database first: a failed write must leave memory untouched)
   * and keep its own bookkeeping — a persisted-message counter, the
   * context-provider anchors — in step. A throw aborts the compaction with
   * the transcript unchanged. */
  replace: (index: number, count: number, message: AgentMessage) => void;
  /** Notify clients that history was condensed (optional: sub-agents have
   * no client surface). */
  onCompacted?: (result: CompactionResult, message: AgentMessage) => void;
}

/** The measurement anchor: the newest provider-reported prompt size, the
 * transcript prefix it priced, and the envelope estimate at that moment (so
 * a system-prompt change afterwards is repriced instead of ignored). */
interface MeasurementAnchor {
  /** Prompt tokens the provider reported for that request. */
  tokens: number;
  /** Number of transcript messages the prompt covered. */
  length: number;
  /** Estimated system-prompt + tools tokens at the same moment. */
  envelopeTokens: number;
}

/**
 * Condenses one conversation's history. Owned by the agent that runs the
 * conversation (the session agent, or one sub-agent); the transcript itself
 * stays the agent's (`Agent.state.messages`) and is only rewritten through
 * the injected `commit`.
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

  /** The budgets of the session's model (undefined when it documents no
   * usable window: compaction is then disabled). */
  budgets(): CompactionBudgets | undefined {
    return resolveCompactionBudgets(
      this.options.model,
      resolveCompactionPolicy(this.options.model),
    );
  }

  /** Record the newest provider-reported prompt size as the measurement
   * anchor. Called before every measurement, so the anchor tracks the
   * newest request the provider actually priced; the delta the heuristic
   * has to estimate is then only what followed that turn. */
  observeTurn(messages: readonly AgentMessage[]): void {
    for (let i = messages.length - 1; i >= 0; i--) {
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
        length: i,
        envelopeTokens: this.envelopeTokens(),
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

  /** Estimated tokens of the next request: the anchored provider figure
   * plus everything appended since, or a full estimate when no anchor
   * applies (no turn reported usage, or a replacement/truncation moved the
   * transcript out from under it). */
  measure(messages: readonly AgentMessage[]): number {
    const anchor = this.anchor;
    if (anchor !== undefined && anchor.length <= messages.length) {
      return anchor.tokens +
        (this.envelopeTokens() - anchor.envelopeTokens) +
        estimateMessagesTokensFrom(messages, anchor.length);
    }
    return this.envelopeTokens() + estimateMessagesTokens(messages);
  }

  /**
   * Condense the transcript when pressure requires it. `force` skips the
   * threshold and retention policy and reduces the history as far as one
   * balanced span allows — the overflow recovery path (a provider-confirmed
   * window rejection), where waiting for the next threshold is not an
   * option.
   *
   * Returns the result, or null when nothing had to (or could) be done. A
   * failed summarization is not an exception for the caller: the transcript
   * is left untouched and the run continues with the history it had.
   */
  async compactIfNeeded(
    messages: AgentMessage[],
    force = false,
  ): Promise<CompactionResult | null> {
    if (this.running) return null;
    const budgets = this.budgets();
    if (budgets === undefined) return null;
    this.observeTurn(messages);
    if (!force) {
      const measured = this.measure(messages);
      if (measured <= budgets.thresholdTokens) return null;
      // The envelope alone (system prompt + tool schemas) is over the
      // threshold: replacing history cannot bring the request under it, so
      // a summarization call would be spent for nothing. DSH draws the same
      // line — compaction shrinks derived history, never the system prompt,
      // the tools, or the session prefix.
      if (this.envelopeTokens() >= budgets.thresholdTokens) return null;
    }
    const attempts = force
      ? 1
      : 1 + resolveCompactionPolicy(this.options.model).compactionRetries;
    let last: CompactionResult | null = null;
    let previous = this.measure(messages);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await this.runOnce(messages, force);
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
  ): Promise<CompactionResult | null> {
    if (this.running) return null;
    this.observeTurn(messages);
    return await this.runOnce(messages, false);
  }

  /** One compaction transaction: select the span, summarize it, and commit
   * the replacement. */
  private async runOnce(
    messages: AgentMessage[],
    force: boolean,
  ): Promise<CompactionResult | null> {
    const budgets = this.budgets();
    if (budgets === undefined) return null;
    const span = selectCompactionSpan(messages, budgets, force);
    if (span === null) return null;
    const replaced = messages.slice(span.index, span.index + span.count);
    this.running = true;
    let summary: string;
    try {
      summary = await this.summarize(replaced);
    } catch (error) {
      // Nothing was rewritten: the transcript keeps the history it had, and
      // the run continues with it (DSH: a summarization failure preserves
      // the latest durable surface).
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
      span.count,
      span.replacedTokens,
      trimmed,
    );
    // A summary that does not shrink its source would make the request
    // bigger: refuse it rather than pay for the replacement (DSH validates
    // the same way).
    if (estimateMessageTokens(checkpoint) >= span.replacedTokens) {
      log.warn(
        `session ${this.options.sessionId}: compaction summary did not ` +
          `shrink its source (${span.replacedTokens} tokens)`,
      );
      return null;
    }
    // The host performs the replacement (durable first). A throw leaves the
    // transcript exactly as it was: nothing to roll back here.
    this.options.replace(span.index, span.count, checkpoint);
    this.anchor = undefined;
    const result: CompactionResult = {
      index: span.index,
      removed: replaced,
      freedTokens: span.replacedTokens - estimateMessageTokens(checkpoint),
    };
    log.debug(
      `session ${this.options.sessionId}: compacted ${span.count} messages ` +
        `(~${result.freedTokens} tokens freed)`,
    );
    this.options.onCompacted?.(result, checkpoint);
    return result;
  }

  /**
   * Write the summary for one span: the session's own system prompt, tool
   * schemas, and the selected messages are replayed verbatim, and the
   * compaction instruction is appended as the final user message — so the
   * provider's warm prefix cache covers everything except the instruction.
   * Only the returned text is kept: reasoning and tool calls would leak
   * private reasoning or create a call with no result.
   */
  private async summarize(span: readonly AgentMessage[]): Promise<string> {
    // The span is replayed as the conversation's own request would send it
    // (notification/context/checkpoint roles become user messages), plus the
    // instruction as the final user message.
    const messages: LlmMessage[] = toLlmMessages([...span]);
    messages.push({
      role: "user",
      content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
      timestamp: Date.now(),
    });
    const tools = this.options.tools();
    return await streamText(
      this.options.streamFn,
      this.options.model,
      {
        systemPrompt: this.options.systemPrompt(),
        messages,
        // Schemas only: the summarizer must not execute anything, but the
        // definitions must match the conversation's own request for the
        // cache prefix to hold.
        ...(tools.length > 0 ? { tools: schemaOnlyTools(tools) } : {}),
      },
      "compaction summarization failed",
      {
        sessionId: this.options.sessionId,
        maxOutputTokens: resolveCompactionPolicy(this.options.model)
          .summarizationMaxTokens,
      },
    );
  }
}

/** Build the checkpoint message: the preamble, the framed summary, and the
 * head line the UI shows. The title never reaches the model — the body
 * carries the model-facing text. */
export function checkpointMessage(
  replacedCount: number,
  replacedTokens: number,
  summary: string,
): CheckpointMessage {
  return {
    role: "checkpoint",
    title: `履歴 ${replacedCount} 件を要約しました（約 ${
      formatTokenCount(replacedTokens)
    } トークン）`,
    body:
      `${CHECKPOINT_PREAMBLE}\n\n<${CHECKPOINT_SUMMARY_TAG}>\n${summary}\n</${CHECKPOINT_SUMMARY_TAG}>`,
    timestamp: Date.now(),
  };
}

/** Compact token count for the checkpoint title ("12K"). */
function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const k = Math.round(value / 100) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return String(value);
}

/** Strip the execute functions from tool definitions: the summarization
 * request replays the schemas but must never run a tool. A model that calls
 * one anyway gets an explicit refusal, which `streamText` surfaces as a
 * failed call (no summary, history untouched). */
function schemaOnlyTools(tools: readonly AgentTool[]): AgentTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: () => {
      throw new CoreError(
        "Tools are not executable during compaction",
        "unavailable",
      );
    },
  }));
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

/** One transcript unit: a message together with the tool results that
 * belong to it. A unit boundary is the only safe cut — an assistant message
 * carrying tool calls must never be separated from its results (providers
 * reject a request with an unanswered call), which is exactly what DSH's
 * tool-pairing balance check enforces. */
interface TranscriptUnit {
  /** 0-based index of the unit's first message. */
  index: number;
  /** Number of messages in the unit. */
  count: number;
  /** Estimated tokens of the unit. */
  tokens: number;
}

/** Split a transcript into compaction units: an assistant message together
 * with the tool results directly following it, or a single message. */
export function transcriptUnits(
  messages: readonly AgentMessage[],
): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  for (let i = 0; i < messages.length;) {
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

/** Fraction of the pressure threshold a span must be worth: replacing less
 * than this cannot meaningfully reduce a request, so the summarization call
 * is not spent on it (DSH's `compactNow` skips a no-op range the same way). */
const MINIMUM_SPAN_RATIO = 0.1;

/**
 * Select the span to replace: the oldest units, stopping where the retained
 * tail reaches its token budget. The newest unit is always retained, so a
 * compaction can never remove the work in progress — the model must keep
 * answering the most recent request.
 *
 * `force` ignores the retention budget and reduces as far as one span can
 * (still keeping the newest unit) — the overflow recovery path, where the
 * alternative is a request the provider already rejected.
 *
 * Two spans are refused in every mode, because summarizing them would churn
 * checkpoints without reducing a request:
 *
 * - one that holds nothing but earlier checkpoints (a previous compaction
 *   that already covered everything up to the retained tail), and
 * - one too small to matter (below {@link MINIMUM_SPAN_RATIO} of the
 *   threshold). This is the case DSH records as out of contract: one
 *   oversized retained unit cannot be repaired by compacting its neighbours.
 */
export function selectCompactionSpan(
  messages: readonly AgentMessage[],
  budgets: CompactionBudgets,
  force = false,
): CompactionSpan | null {
  const units = transcriptUnits(messages);
  if (units.length < 2) return null;
  // Walk the tail backwards: keep the newest unit, then extend while the
  // retention budget is not met. Everything before the cut is compacted.
  let cutUnit = units.length - 1;
  let retainedTokens = units[cutUnit]!.tokens;
  while (!force && cutUnit > 0 && retainedTokens < budgets.retainTokens) {
    cutUnit--;
    retainedTokens += units[cutUnit]!.tokens;
  }
  if (cutUnit <= 0) return null;
  const first = units[0]!;
  const last = units[cutUnit - 1]!;
  let replacedTokens = 0;
  let hasSourceMessage = false;
  for (let i = 0; i < cutUnit; i++) {
    replacedTokens += units[i]!.tokens;
    for (let j = units[i]!.index; j < units[i]!.index + units[i]!.count; j++) {
      if (messages[j]!.role !== "checkpoint") hasSourceMessage = true;
    }
  }
  if (!hasSourceMessage) return null;
  if (replacedTokens < budgets.thresholdTokens * MINIMUM_SPAN_RATIO) {
    return null;
  }
  const count = last.index + last.count - first.index;
  if (count <= 0) return null;
  return { index: first.index, count, replacedTokens };
}
