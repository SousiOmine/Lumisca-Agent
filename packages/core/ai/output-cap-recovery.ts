/**
 * Output-cap recovery: a request the provider rejected as too large for its
 * window is re-sent with a smaller completion cap, everything else
 * unchanged.
 *
 * The transport always asks for the model's documented cap (models.dev
 * `limit.output`) and clamps it to the room the prompt leaves (see
 * ai/stream.ts clampMaxTokensToContext). That clamp is priced by a token
 * estimate; when the estimate under-counts (code and JSON tokenize denser
 * than the heuristic's four characters per token), the request goes out
 * wider than the window allows and the provider rejects it even though the
 * prompt itself fits. Shrinking the cap is then a complete repair: the
 * history does not have to change at all.
 *
 * The provider's rejection names the numbers it validated against, so the
 * retry uses its own count rather than another estimate — a prompt the
 * provider says left 381,645 tokens for the completion gets a cap that
 * leaves a small envelope below it. The retry is bounded
 * ({@link MAX_OUTPUT_CAP_RECOVERIES}) and only ever narrows the cap, so it
 * can neither loop nor widen a request the provider already refused.
 */

import { createLogger } from "../log.ts";
import {
  isContextOverflowText,
  parseContextOverflow,
} from "./context-overflow.ts";
import { describeFailedCall, failureText } from "./error-detail.ts";
import type { StreamEvent } from "./types.ts";

const log = createLogger("ai");

/** Envelope kept below the window the provider enforced when the retry's cap
 * is derived from its own counts. The retry re-sends the identical prompt,
 * so the provider's arithmetic is exact; the margin only absorbs wording
 * that reports the envelope slightly differently between the two requests. */
export const OVERFLOW_SAFETY_TOKENS = 1_024;

/** Smallest cap worth a retry. Below this the prompt is effectively at the
 * window, where no completion size repairs the request: the history has to
 * shrink (the compactor's overflow recovery, see agent/session-agent.ts), so
 * the provider's error is surfaced and that path takes over. */
export const MIN_RECOVERED_OUTPUT_TOKENS = 1_024;

/** Retries per request. The first retry is priced from the provider's own
 * numbers and should succeed; the second only matters when the provider
 * named no counts and the cap is halved instead. */
export const MAX_OUTPUT_CAP_RECOVERIES = 2;

/**
 * The completion cap to retry with after `text` rejected the request that
 * asked for `sentCap`, or undefined when no smaller cap can help.
 *
 * When the message carries both counts, the room is the provider's own
 * arithmetic (`window - prompt - OVERFLOW_SAFETY_TOKENS`); otherwise the cap
 * is halved, which cannot repeat the same rejection but wastes output when
 * the prompt is far below the window. Either way the result is strictly
 * below `sentCap` and at least {@link MIN_RECOVERED_OUTPUT_TOKENS} — a cap
 * of a few tokens would only replace one useless turn with another.
 */
export function recoveredOutputCap(
  text: string,
  sentCap: number | undefined,
): number | undefined {
  if (!isContextOverflowText(text)) return undefined;
  const { windowTokens, promptTokens } = parseContextOverflow(text);
  const room = windowTokens !== undefined && promptTokens !== undefined
    ? windowTokens - promptTokens - OVERFLOW_SAFETY_TOKENS
    : undefined;
  let next = room ??
    (sentCap === undefined ? undefined : Math.floor(sentCap / 2));
  if (next === undefined) return undefined;
  // A retry must narrow the request: a cap the arithmetic says fits is only
  // useful while it is smaller than the one the provider just refused.
  if (sentCap !== undefined) next = Math.min(next, sentCap - 1);
  if (next < MIN_RECOVERED_OUTPUT_TOKENS) return undefined;
  return Math.floor(next);
}

/** Events that carry model output: once one of them reached the caller, a
 * retry would replay it and must not happen. Only the failed attempt's own
 * bookkeeping (`start`, `error`) may safely be dropped. */
const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
  "toolcall_start",
  "toolcall_result",
]);

/** The failed event's text, message and detail together — the provider's
 * counts may sit in either (the detail carries the response body). */
function errorTextOf(event: {
  errorMessage?: string;
  errorDetail?: string;
}): string {
  return [event.errorMessage, event.errorDetail]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

/** The collaborators of one recovering request. */
export interface OutputCapRecoveryOptions {
  /** Open one attempt with this completion cap (undefined: the model's own
   * cap applies, as the transport computes it). */
  open: (cap: number | undefined) => AsyncIterable<StreamEvent>;
  /** The cap the first attempt asks for (StreamOptions.maxOutputTokens). */
  initialCap?: number;
  /** The caller's abort signal: a cancelled call is never retried. */
  signal?: AbortSignal;
}

/**
 * Wrap a request so a context-window rejection shrinks its completion cap and
 * re-sends it instead of failing the turn.
 *
 * The caller sees exactly one `start`, every content event of the attempt
 * that finally succeeded, and either a `done` or the provider's original
 * `error` when no smaller cap could help. A thrown failure (the transport
 * rejects before its event loop, e.g. an unresolvable credential) propagates
 * unchanged unless it is an overflow that nothing was produced from.
 */
export async function* withOutputCapRecovery(
  options: OutputCapRecoveryOptions,
): AsyncGenerator<StreamEvent> {
  let cap = options.initialCap;
  // The caller wants one placeholder per turn: the first attempt normally
  // emits it, and a retry must not replace it with an identical copy. A
  // failure thrown before the first attempt ever reached its `start` lets
  // the retry's start through instead.
  let started = false;
  for (let attempt = 0;; attempt++) {
    let produced = false;
    let retryWith: number | undefined;
    try {
      for await (const event of options.open(cap)) {
        if (event.type === "start") {
          if (!started) {
            started = true;
            yield event;
          }
          continue;
        }
        if (event.type === "error") {
          retryWith = retryCapFor(
            errorTextOf(event),
            cap,
            produced,
            attempt,
            options.signal,
          );
          if (retryWith !== undefined) break;
          yield event;
          return;
        }
        if (CONTENT_EVENTS.has(event.type)) produced = true;
        yield event;
        if (event.type === "done") return;
      }
    } catch (error) {
      retryWith = retryCapFor(
        failureText(describeFailedCall(error)),
        cap,
        produced,
        attempt,
        options.signal,
      );
      // Not recoverable: the failure reaches the caller exactly as it would
      // without this wrapper.
      if (retryWith === undefined) throw error;
    }
    if (retryWith === undefined) return;
    // Info level (not debug): a recovery means the token estimate
    // under-counted the prompt, which is worth seeing in the server log even
    // though the turn itself looks fine to the user.
    log.info(
      `output cap ${cap ?? "auto"} rejected as too large: retrying with ` +
        `${retryWith} (recovery ${attempt + 1}/${MAX_OUTPUT_CAP_RECOVERIES})`,
    );
    cap = retryWith;
  }
}

/** The retry decision shared by both failure paths (an `error` event and a
 * thrown error): a smaller cap when this attempt failed on an overflow
 * before producing output, the attempt budget still allows it, and the
 * caller has not cancelled. */
function retryCapFor(
  text: string,
  cap: number | undefined,
  produced: boolean,
  attempt: number,
  signal: AbortSignal | undefined,
): number | undefined {
  if (produced || signal?.aborted === true) return undefined;
  if (attempt >= MAX_OUTPUT_CAP_RECOVERIES) return undefined;
  const next = recoveredOutputCap(text, cap);
  // An overflow that a smaller cap cannot repair: the prompt is at the
  // window, so the history has to shrink instead (see the module comment).
  if (next === undefined && isContextOverflowText(text)) {
    log.debug(`context overflow needs a smaller history: ${text}`);
  }
  return next;
}
