/**
 * The rate-limit retry policy, shared by every LLM entry point:
 *
 * - the transport's `streamText` (title generation, image analysis, goal
 *   judging, command safety) retries the whole call,
 * - the session agent's `RetryManager` retries a parked assistant turn,
 * - the sub-agent hub retries a rate-limited sub-agent run.
 *
 * The classifier lives here and only here: two copies of the keyword
 * patterns would let one path retry a quota exhaustion the other fails
 * fast on.
 */

/** Budget and delay shape of one retry loop. */
export interface RateLimitRetryOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  maxRetryDelayMs?: number;
  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
  /** Backoff sleep (injectable for tests); defaults to sleepAbortable. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const MAX_RATE_LIMIT_RETRIES = 5;
export const RATE_LIMIT_BASE_DELAY_MS = 2000;
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** Account/subscription limits: not transient throttling, so they must fail
 * fast instead of being retried. */
const NON_RETRYABLE_PATTERN = buildPattern([
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
 * wording. */
const RETRYABLE_PATTERN = buildPattern([
  "rate.?limit",
  "rate_limit_exceeded",
  "too many requests",
  "\\b429\\b",
]);

function buildPattern(patterns: string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

/** Classify a raw error message. Shared by the Error-level and the
 * assistant-message-level check so both agree by construction. */
export function isRetryableRateLimitMessage(message: string): boolean {
  if (NON_RETRYABLE_PATTERN.test(message)) return false;
  return RETRYABLE_PATTERN.test(message);
}

export function isRetryableRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) return false;
  return isRetryableRateLimitMessage(error.message);
}

export function rateLimitRetryDelayMs(attempt: number): number {
  return Math.round(
    Math.min(
      RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1),
      RATE_LIMIT_MAX_DELAY_MS,
    ) * (1 - Math.random() * 0.25),
  );
}

/** Error thrown when the backoff sleep is aborted, so callers can normalize
 * an abort during backoff to their own terminal/aborted state. */
export class RetryAbortError extends Error {
  constructor() {
    super("Aborted during rate-limit retry backoff");
    this.name = "RetryAbortError";
  }
}

/** Sleep that rejects with RetryAbortError when `signal` fires. */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new RetryAbortError());
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

export async function retryOnRateLimitError<T>(
  attempt: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  opts: RateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  const sleepFn = opts.sleep ?? sleepAbortable;
  let lastError: unknown;
  for (let n = 0;; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (opts.signal?.aborted) throw new RetryAbortError();
      if (n >= maxRetries || !isRetryable(error)) throw error;
      lastError = error;
      const delayMs = rateLimitRetryDelayMs(n + 1);
      opts.onRetry?.(n + 1, maxRetries, delayMs);
      try {
        await sleepFn(delayMs, opts.signal);
      } catch {
        throw lastError;
      }
    }
  }
}
