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
  CheckpointMessage,
  LlmMessage,
  Model,
  StreamFn,
} from "./types.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { streamText } from "./stream.ts";
import {
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolTokens,
} from "../shared/token-estimate.ts";
import { contextTokensOf } from "../shared/context-usage.ts";
import { DEFAULT_LOCALE, type Locale, translate } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import {
  buildSummarizationPrompt,
  contextStart,
  estimateMessagesTokensFrom,
  selectCompactionSpan,
} from "./compaction-span.ts";

export type { CompactionSpan } from "./compaction-span.ts";
export {
  contextStart,
  selectCompactionSpan,
  type TranscriptUnit,
  transcriptUnits,
} from "./compaction-span.ts";
import { CHECKPOINT_SUMMARY_TAG } from "./compaction-prompts.ts";
import type { CompactionStyle } from "./compaction-style.ts";
import {
  type CompactionBudgets,
  type CompactionPolicy,
  resolveCompactionBudgets,
  resolveCompactionPolicy,
} from "./compaction-policy.ts";

export {
  CHECKPOINT_PREAMBLE,
  CHECKPOINT_SUMMARY_TAG,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./compaction-prompts.ts";
export {
  type CompactionBudgets,
  type CompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
  resolveCompactionBudgets,
  resolveCompactionPolicy,
  shareOfWindow,
} from "./compaction-policy.ts";

/** Module logger (debug-gated): every compaction outcome is logged so a
 * session that kept working past its window can be traced. */
const log = createLogger("compaction");

/** Extra compaction passes per check, each one a summarization call. The
 * second pass only runs while the projection is still over the threshold
 * (pi re-checks on every turn instead; a single check here may need two
 * passes because the retained tail can itself be large). */
const MAX_COMPACTION_ATTEMPTS = 2;

/** Structural overhead charged for the request envelope (role markers and
 * the tool-calling scaffold around the system prompt). */
const ENVELOPE_OVERHEAD_TOKENS = 32;

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
  /** What the summary is made of and what it is asked to be: a code
   * session's work log, or a stella conversation's record (see
   * ai/compaction-style.ts and agent/stella-compaction.ts). */
  style: CompactionStyle;
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
  onCompacted?: (result: CompactionResult, message: CheckpointMessage) => void;
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
   * `/compact` path, and the idle check). Returns null when no safe span
   * exists. */
  async compactNow(
    messages: AgentMessage[],
    options: {
      /** The user's extra focus for the summary (`/compact <focus>`). */
      instructions?: string;
      /** Checked right before the checkpoint is committed. Returning false
       * abandons the compaction with the transcript untouched — the caller
       * saw the transcript move while the summary was being written (a run
       * started, a rewind truncated it), and the span selected here no
       * longer describes it. Omitted → the checkpoint is always committed. */
      canCommit?: () => boolean;
      /** Retention override for this one call: the newest this many tokens
       * stay verbatim instead of the policy's share of the window. The idle
       * check passes an absolute count because its trigger is absolute (see
       * SessionAgentOptions.idleCompaction). Omitted → the policy's share. */
      keepRecentTokens?: number;
    } = {},
  ): Promise<CompactionResult | null> {
    if (this.running) return null;
    this.observeTurn(messages);
    return await this.runOnce(
      messages,
      false,
      options.instructions,
      options.canCommit,
      options.keepRecentTokens,
    );
  }

  /** One compaction transaction: select the head, summarize it, and commit
   * the checkpoint. */
  private async runOnce(
    messages: AgentMessage[],
    force: boolean,
    instructions?: string,
    canCommit?: () => boolean,
    keepRecentTokens?: number,
  ): Promise<CompactionResult | null> {
    const budgets = this.budgets();
    if (budgets === undefined) return null;
    // The retention is the only budget this call may replace: the window,
    // the threshold and the summary's output cap stay the model's.
    const retention = keepRecentTokens === undefined
      ? budgets
      : { ...budgets, keepRecentTokens };
    const span = selectCompactionSpan(
      messages,
      contextStart(messages),
      retention,
      force,
    );
    if (span === null) return null;
    const head = messages.slice(span.start, span.cutIndex);
    // The checkpoint at the head's start is not replayed as a message: its
    // summary travels to the summarizer separately (the style decides how —
    // see CompactionStyle.prompt).
    const previous = head[0]?.role === "checkpoint"
      ? checkpointSummaryText(head[0])
      : undefined;
    this.running = true;
    let summary: string;
    try {
      summary = await this.summarize(head, previous, instructions, budgets);
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
    // The summary took a whole LLM call to write; the transcript may have
    // moved on meanwhile (a run appended a prompt, a rewind truncated the
    // span that was summarized). Inserting then would splice a checkpoint
    // that no longer describes what follows it, so the caller's check runs
    // here — after the call, before the write.
    if (canCommit !== undefined && !canCommit()) {
      log.debug(
        `session ${this.options.sessionId}: compaction abandoned, the ` +
          `transcript changed while its summary was written`,
      );
      return null;
    }
    const checkpoint = checkpointMessage(
      head.length,
      span.headTokens,
      trimmed,
      this.options.style.preamble,
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
   * Write the summary for one head: the style serializes it (a code session
   * keeps the tool output, a stella conversation keeps only what it said) and
   * supplies the instruction and the system prompt, so the model summarizes
   * instead of continuing the conversation. The session's own system prompt
   * and tools are deliberately not part of the request: the head already sits
   * near the window, and the auxiliary request must leave room for its own
   * output (pi does the same).
   */
  private async summarize(
    head: readonly AgentMessage[],
    previous: string | undefined,
    instructions: string | undefined,
    budgets: CompactionBudgets,
  ): Promise<string> {
    const focus = instructions?.trim();
    let skeleton = this.options.style.prompt(previous);
    if (focus !== undefined && focus.length > 0) {
      skeleton += `\n\nAdditional focus: ${focus}`;
    }
    const prompt = buildSummarizationPrompt(
      this.options.style.serialize(head, previous),
      skeleton,
      budgets,
      this.options.sessionId,
    );
    const request = {
      systemPrompt: this.options.style.systemPrompt,
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
        maxOutputTokens: this.options.style.maxTokens(budgets),
      },
    );
  }
}

/** Build the checkpoint message: the style's preamble, the framed summary,
 * and the head line the UI shows. The title never reaches the model — the
 * body carries the model-facing text. */
export function checkpointMessage(
  summarizedCount: number,
  summarizedTokens: number,
  summary: string,
  preamble: string,
  language: Locale = DEFAULT_LOCALE,
): CheckpointMessage {
  return {
    role: "checkpoint",
    title: translate(language, "checkpoint.title", {
      count: summarizedCount,
      tokens: formatTokenCount(summarizedTokens),
    }),
    body:
      `${preamble}\n\n<${CHECKPOINT_SUMMARY_TAG}>\n${summary}\n</${CHECKPOINT_SUMMARY_TAG}>`,
    timestamp: Date.now(),
  };
}

/** The summary text of a checkpoint (the body minus the preamble and the
 * framing tags), which the next compaction carries forward as the previous
 * summary or record. */
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
