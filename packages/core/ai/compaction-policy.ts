/**
 * When to compact, and how much room a compaction may use: the tuning
 * (shares of the model's window, not token counts) and the budgets derived
 * from it.
 *
 * Kept out of context-compaction.ts so the tuning can be read and changed on
 * its own: it is the part a user's settings move, while the class next door
 * is the mechanism that runs once a decision is made.
 */
import { inputBudgetTokens } from "../shared/context-usage.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import {
  COMPACTION_DEFAULT_KEEP_RECENT_PERCENT,
  COMPACTION_DEFAULT_RESERVE_PERCENT,
} from "../shared/settings-keys.ts";
import type { Api, Model } from "./types.ts";

/** Output floor of the summarization request. Below this a summary could
 * not say anything, so the conversation is trimmed instead of failing. */
/** Fallback output cap of the summarization request when the policy reserves
 * no room (reserveTokens = 0) and the model documents no cap. */
const FALLBACK_SUMMARY_MAX_TOKENS = 8_192;

/** The compaction tuning (pi's `CompactionSettings`): whether automatic
 * compaction runs, how much room below the window it leaves for the next
 * request, and how much of the newest history stays verbatim.
 *
 * Both sizes are SHARES of the model's window, not token counts: the same
 * count means something different on every model. 16k of a 32k window is
 * half of it; 16k of a 1M window is 98.4% used before anything happens —
 * one turn from a rejected request — and it leaves 240k of history to
 * collapse into 20k, so a compaction on a large window loses most of what
 * it was told to keep. A share behaves the same at every size. */
export interface CompactionPolicy {
  enabled: boolean;
  /** Compact once the projected context passes this share of the window.
   * It is also the room the summarization request may use for its own
   * output (see CompactionBudgets.summaryMaxTokens). */
  reservePercent: number;
  /** Share of the window kept verbatim. The cut lands on a unit boundary,
   * so the retained tail is this share rounded up. */
  keepRecentPercent: number;
}

/** pi's defaults, as shares: 16k and 20k against the 200k window they were
 * chosen for. */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  enabled: true,
  reservePercent: COMPACTION_DEFAULT_RESERVE_PERCENT,
  keepRecentPercent: COMPACTION_DEFAULT_KEEP_RECENT_PERCENT,
};

/** The token budgets one model can actually be asked for. `undefined` when
 * the model documents no window (compaction then stays off: without a
 * capacity there is nothing to measure pressure against) or when the
 * policy disables it. */
export interface CompactionBudgets {
  /** The model's prompt budget: its documented window, narrowed to the
   * input cap the catalog publishes (models.dev `limit.input`) — the two
   * differ for models whose window counts the completion (see
   * shared/context-usage.ts inputBudgetTokens). */
  contextWindow: number;
  /** Room the window keeps free below the threshold
   * (`contextWindow - thresholdTokens`): what a request that reaches the
   * threshold may still ask for as output. */
  reserveTokens: number;
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
    reservePercent:
      percent(input?.reservePercent) ??
      DEFAULT_COMPACTION_POLICY.reservePercent,
    keepRecentPercent:
      percent(input?.keepRecentPercent) ??
      DEFAULT_COMPACTION_POLICY.keepRecentPercent,
  };
}

/** A whole percentage in 0-100, or undefined (an out-of-range value is
 * refused rather than clamped: a typo must not silently mean another
 * policy). */
function percent(value: number | undefined): number | undefined {
  const parsed = nonNegativeInt(value);
  return parsed !== undefined && parsed <= 100 ? parsed : undefined;
}

/** A share of `window` in tokens, rounded up so a non-zero share never
 * becomes zero room. */
export function shareOfWindow(window: number, percentValue: number): number {
  return Math.ceil((window * percentValue) / 100);
}

function nonNegativeInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Resolve the token budgets of a model: the threshold sits the policy's
 * reserve SHARE below the model's prompt budget — its window narrowed to
 * the input cap the catalog publishes (models.dev `limit.input`) — and the
 * summarization call may use at most 80% of that reservation for its own
 * output (pi's `maxTokens`).
 *
 * The shares are turned into tokens here, against the window this model
 * actually has, so the same policy describes the same behaviour at 32k and
 * at 1M. A reservation of 100% (or a window so small it rounds to nothing)
 * leaves no room for a prompt; compaction is then off rather than useless.
 */
export function resolveCompactionBudgets(
  model: Model<Api>,
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionBudgets | undefined {
  if (!policy.enabled) return undefined;
  // The budget is the prompt a request may actually carry: the window
  // narrowed to the documented input cap. A provider that publishes both
  // numbers rejects a prompt past the smaller one, so the threshold has to
  // hang off it rather than off the window.
  const window = inputBudgetTokens(model);
  if (window === undefined) {
    return undefined;
  }
  const reserveTokens = shareOfWindow(window, policy.reservePercent);
  const threshold = window - reserveTokens;
  // A reservation as large as the window leaves no room for a prompt:
  // compacting would not make the request acceptable either.
  if (threshold <= 0) return undefined;
  const outputCap =
    model.maxTokens !== undefined && model.maxTokens > 0
      ? model.maxTokens
      : undefined;
  const summaryMaxTokens =
    reserveTokens > 0
      ? Math.max(
          1,
          Math.min(
            Math.floor(reserveTokens * 0.8),
            outputCap ?? Number.POSITIVE_INFINITY,
          ),
        )
      : (outputCap ?? FALLBACK_SUMMARY_MAX_TOKENS);
  return {
    contextWindow: window,
    reserveTokens,
    thresholdTokens: threshold,
    keepRecentTokens: shareOfWindow(window, policy.keepRecentPercent),
    summaryMaxTokens,
  };
}

/**
 * The completion cap a request may ask for under this policy: the model's
 * documented cap, narrowed to the room the policy reserves below its
 * threshold (`CompactionBudgets.reserveTokens`).
 *
 * The request and the compaction decision then describe the same limit.
 * Providers validate prompt + completion against the window, so a cap
 * larger than the reservation makes the request at the threshold
 * impossible — no matter how the prompt was priced. The clamp in
 * ai/budget.ts still narrows the cap by the prompt's own estimate; this is
 * the bound that estimate cannot promise.
 *
 * The model's documented cap stands when the policy reserves nothing
 * (compaction off, or reservePercent 0): there is no threshold to keep, and
 * the clamp below the window is the only bound left. undefined when the
 * model documents no cap — the provider's default applies, and inventing a
 * larger one would be a request the provider never agreed to.
 */
export function reservedCompletionTokens(
  model: Model<Api>,
  policy: CompactionPolicyInput,
): number | undefined {
  const documented =
    model.maxTokens !== undefined && model.maxTokens > 0
      ? model.maxTokens
      : undefined;
  if (documented === undefined) return undefined;
  const budgets = resolveCompactionBudgets(
    model,
    resolveCompactionPolicy(policy),
  );
  if (budgets === undefined || budgets.reserveTokens === 0) return documented;
  return Math.min(documented, budgets.reserveTokens);
}
