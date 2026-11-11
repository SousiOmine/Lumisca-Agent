/** How much room a request's prompt leaves for its completion.
 *
 * Three questions live here, and only here: how large the prompt is
 * estimated to be, how much margin to keep between that estimate and the
 * model's window, and how much of the window the compaction policy reserves
 * for the completion. The recovery path (output-cap-recovery.ts) reads the
 * same policy when a provider rejects a request anyway.
 */

import { inputBudgetTokens } from "../shared/context-usage.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import {
  estimateLlmMessagesTokens,
  estimateTextTokens,
  estimateToolTokens,
} from "../shared/token-estimate.ts";
import { reservedCompletionTokens } from "./compaction-policy.ts";
import type { Api, Model, StreamOptions, StreamRequest } from "./types.ts";

/** The completion cap to send for one request: the caller's override when it
 * set one, else the model's documented `maxTokens`, else none (the
 * provider's own default). */
export function outputCapFor(
  model: Model<Api>,
  options: StreamOptions | undefined,
): number | undefined {
  const override = options?.maxOutputTokens;
  if (override !== undefined && override > 0) return override;
  return model.maxTokens !== undefined && model.maxTokens > 0
    ? model.maxTokens
    : undefined;
}

/** What that cap becomes once the compaction policy has its say: no request
 * asks for more output than the room the policy reserves below the
 * threshold. A prompt the pressure check lets through is at most the
 * threshold, so the two bounds now have to agree — a larger cap would make
 * the request exceed the window even though nothing had to be condensed.
 * Undefined when there is no cap to send (see outputCapFor). */
export function reservedOutputCapFor(
  model: Model<Api>,
  options: StreamOptions | undefined,
  policy: CompactionPolicyInput,
): number | undefined {
  const desired = outputCapFor(model, options);
  const reserved = reservedCompletionTokens(model, policy);
  if (desired === undefined || reserved === undefined) return desired;
  return Math.min(desired, reserved);
}

/** Room kept between the prompt and the window when clamping an output cap:
 * the token estimate is a heuristic, and a request the provider rejects
 * costs a whole turn. Mirrors pi's CONTEXT_SAFETY_TOKENS — the floor of the
 * margin; large prompts charge more (see {@link contextSafetyTokens}). */
export const CONTEXT_SAFETY_TOKENS = 4_096;

/** Share of the estimated prompt charged as margin on top of the floor.
 *
 * The estimate prices ASCII at four characters per token, while source code
 * and JSON (tool schemas included) tokenize closer to three: a long prompt
 * is therefore under-counted by more than a fixed 4,096 can absorb, and the
 * cap the clamp believes fits is rejected by the provider (observed: a
 * conversation the provider counted at 666,931 tokens on a 1,000,000 window
 * had been estimated low enough to send the model's full 384,000 cap, which
 * overshot by 2,355). Charging a share of the prompt makes the margin grow
 * with exactly the quantity the estimate gets wrong. */
export const CONTEXT_SAFETY_RATIO = 0.1;

/** Cap on the proportional margin as a share of the room the prompt leaves:
 * the margin must never eat more than half of it, or a prompt just below the
 * window would collapse the cap to nothing (a request that cannot answer is
 * worse than one the provider rejects — the latter has a repair). */
const CONTEXT_SAFETY_MAX_SHARE = 0.5;

/**
 * The margin kept between the estimated prompt and the window: the larger of
 * {@link CONTEXT_SAFETY_TOKENS} and {@link CONTEXT_SAFETY_RATIO} of the
 * prompt, bounded to half the room the prompt leaves.
 */
export function contextSafetyTokens(
  promptTokens: number,
  window: number,
): number {
  const room = Math.max(0, window - promptTokens);
  const proportional = Math.ceil(promptTokens * CONTEXT_SAFETY_RATIO);
  return Math.max(
    CONTEXT_SAFETY_TOKENS,
    Math.min(proportional, Math.floor(room * CONTEXT_SAFETY_MAX_SHARE)),
  );
}

/** The smallest cap a clamped request may carry (pi's MIN_MAX_TOKENS): a
 * cap of zero would ask for no output at all. */
export const MIN_MAX_TOKENS = 1;

/** Estimated prompt size of one request: the converted messages, the system
 * prompt, and the tool schemas — the three parts a provider counts. */
export function promptTokensFor(context: StreamRequest): number {
  let tokens = estimateLlmMessagesTokens(context.messages);
  if (context.systemPrompt !== undefined) {
    tokens += estimateTextTokens(context.systemPrompt);
  }
  for (const tool of context.tools ?? []) {
    tokens += estimateToolTokens(tool);
  }
  return tokens;
}

/**
 * Clamp a request's output cap to the room its prompt leaves (pi's
 * `clampMaxTokensToContext`). Providers validate `prompt + max_output`
 * against the prompt budget — the window, narrowed to the input cap the
 * catalog publishes (see shared/context-usage.ts inputBudgetTokens) — so a
 * cap the prompt cannot fit would fail the whole request; the compaction
 * threshold deliberately lets the conversation come close to that budget,
 * which is exactly when this matters.
 *
 * The clamp only ever shrinks a cap — never invents one for a request that
 * carries none (the provider's own default then applies) — and never goes
 * below {@link MIN_MAX_TOKENS}. A caller's override (the compaction
 * summarizer's smaller cap) is clamped the same way, so the auxiliary
 * request stays inside the budget too. The margin itself is proportional to
 * the prompt (see {@link contextSafetyTokens}): a fixed reserve is too small
 * to cover the estimate's error on a large window.
 */
export function clampMaxTokensToContext(
  model: Model<Api>,
  promptTokens: number,
  desired: number | undefined,
): number | undefined {
  if (desired === undefined) return undefined;
  const window = inputBudgetTokens(model);
  if (window === undefined) {
    return Math.max(MIN_MAX_TOKENS, desired);
  }
  const available =
    window - promptTokens - contextSafetyTokens(promptTokens, window);
  return Math.min(desired, Math.max(MIN_MAX_TOKENS, available));
}
