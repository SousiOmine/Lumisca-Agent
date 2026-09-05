import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** Max retries for a rate-limited (429) assistant turn before giving up.
 * Independent of the vacant-response budget in SessionAgent — a long rate
 * limit storm must not be cut short by the vacant-response cap, nor starve
 * it. The initial attempt counts as 1, so up to MAX_RATE_LIMIT_RETRIES
 * additional attempts are made (MAX_RATE_LIMIT_RETRIES + 1 calls total). */
export const MAX_RATE_LIMIT_RETRIES = 5;

/** Base backoff delay in ms; per-attempt delay is BASE * 2^(attempt-1) before
 * jitter (2s, 4s, 8s, …). Mirrors retryAssistantCall in pi-ai. */
export const RATE_LIMIT_BASE_DELAY_MS = 2000;

/** Hard cap on the wait before any single retry attempt (mirrors the 60s SDK
 * default applied to provider-requested delays). */
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** Provider-default retry budget for the initial HTTP request. Mirrors the
 * OpenAI/Anthropic SDK defaults so transient 429s on the first request are
 * retried with backoff even before the assistant-level retry sees them. */
export const PROVIDER_DEFAULT_MAX_RETRIES = 5;
/** Cap for provider-requested Retry-After delays (ms); above this the
 * provider's request fails fast so higher-level retry logic can take over. */
export const PROVIDER_DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** Account/subscription limits: not transient throttling, so they must fail
 * fast instead of being retried. Mirrors pi-ai's non-retryable limit set
 * (retry.js) so the two classification layers stay consistent. */
const NON_RETRYABLE_RATE_LIMIT_PATTERN = buildPattern([
  // Subscription/account limits returned as 429 by some gateways.
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
]);

/** Retryable rate-limit signatures: the 429 status text and common gateway
 * wording. The reported "OpenAI API error (429): ... rate_limit_exceeded ..."
 * lands here, as does "too many requests" and a bare 429. */
const RETRYABLE_RATE_LIMIT_PATTERN = buildPattern([
  "rate.?limit",
  "rate_limit_exceeded",
  "too many requests",
  "\\b429\\b",
]);

function buildPattern(patterns: string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

/** True when an error-stopped assistant message is a transient rate-limit
 * failure worth retrying (e.g. "OpenAI API error (429): ...rate_limit_exceeded").
 * Quota/billing exhaustion is excluded so deterministic failures fail fast. */
export function isRetryableRateLimit(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  if (NON_RETRYABLE_RATE_LIMIT_PATTERN.test(message.errorMessage)) return false;
  return RETRYABLE_RATE_LIMIT_PATTERN.test(message.errorMessage);
}

/** True when a thrown stream error is a retryable rate limit (the error
 * message carries the provider text). Used by streamText's retry loop. */
export function isRetryableRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) return false;
  if (NON_RETRYABLE_RATE_LIMIT_PATTERN.test(error.message)) return false;
  return RETRYABLE_RATE_LIMIT_PATTERN.test(error.message);
}

/** Delay in ms before retry `attempt` (1-indexed), capped at
 * RATE_LIMIT_MAX_DELAY_MS with +/-25% jitter (matches the OpenAI/Anthropic
 * SDK policy and retryAssistantCall in pi-ai). Pure (no timer) so tests
 * assert the sequence without sleeping. */
export function rateLimitRetryDelayMs(attempt: number): number {
  const raw = Math.min(
    RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1),
    RATE_LIMIT_MAX_DELAY_MS,
  );
  return Math.round(raw * (1 - Math.random() * 0.25));
}

/** Error thrown when the backoff sleep is aborted, so callers can normalize
 * an abort during backoff to their own terminal/aborted state. */
export class RetryAbortError extends Error {
  constructor() {
    super("Aborted during rate-limit retry backoff");
    this.name = "RetryAbortError";
  }
}

/** Sleep that rejects with RetryAbortError when `signal` fires, so a user
 * stop during backoff cancels the retry immediately instead of hanging. */
export async function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new RetryAbortError();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Options for {@link retryOnRateLimitError}. */
export interface RateLimitRetryOptions {
  /** Max retry attempts after the first failure (default MAX_RATE_LIMIT_RETRIES). */
  maxRetries?: number;
  /** Backoff sleep (injectable for tests); defaults to sleepAbortable. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Abort signal cancelling the backoff and the whole operation. */
  signal?: AbortSignal;
  /** Called before each backoff sleep (attempt, maxRetries, delayMs). */
  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

/** Run `attempt` until it succeeds, throws a non-rate-limit error, or the
 * retry budget is exhausted. Transient rate-limit throws are retried with
 * exponential backoff; an abort during the backoff normalizes to the last
 * captured error (so the operation ends as a failure, not a thrown abort). */
export async function retryOnRateLimitError<T>(
  attempt: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  opts: RateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  const sleep = opts.sleep ?? sleepAbortable;
  let lastError: unknown;
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (opts.signal?.aborted) throw new RetryAbortError();
      if (n >= maxRetries || !isRetryable(error)) throw error;
      lastError = error;
      const delayMs = rateLimitRetryDelayMs(n + 1);
      opts.onRetry?.(n + 1, maxRetries, delayMs);
      try {
        await sleep(delayMs, opts.signal);
      } catch (abortErr) {
        throw abortErr instanceof RetryAbortError ? lastError : abortErr;
      }
    }
  }
}

/** Wrap a stream function so the initial HTTP request retries on transient
 * errors (429, 5xx) with backoff — enabling the provider's built-in
 * retryProviderRequest for every LLM call that does not already set its own
 * retry budget. Provider-requested Retry-After delays are honored up to the
 * cap. */
export function withProviderRetryDefaults(base: StreamFn): StreamFn {
  return (model, context, options) =>
    base(model, context, applyProviderRetryDefaults(options));
}

/** Fill in provider retry defaults when the caller left them unset. */
export function applyProviderRetryDefaults(
  options: Parameters<StreamFn>[2],
): Parameters<StreamFn>[2] {
  if (options === undefined) {
    return {
      maxRetries: PROVIDER_DEFAULT_MAX_RETRIES,
      maxRetryDelayMs: PROVIDER_DEFAULT_MAX_RETRY_DELAY_MS,
    };
  }
  if (options.maxRetries === undefined && options.maxRetryDelayMs === undefined) {
    return {
      ...options,
      maxRetries: PROVIDER_DEFAULT_MAX_RETRIES,
      maxRetryDelayMs: PROVIDER_DEFAULT_MAX_RETRY_DELAY_MS,
    };
  }
  return options;
}
