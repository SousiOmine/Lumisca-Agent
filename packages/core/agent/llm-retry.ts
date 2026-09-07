import type { AssistantMessage } from "../ai/types.ts";
import type { StreamFn } from "../ai/types.ts";
import {
  isRetryableRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  rateLimitRetryDelayMs,
  RetryAbortError,
  retryOnRateLimitError,
  sleepAbortable,
  type RateLimitRetryOptions,
} from "../ai/stream.ts";

// The rate-limit retry primitives live in the transport (ai/stream.ts); the
// session agent and sub-agent hub keep importing them from here (their
// historical home), and only the assistant-message-level classification and
// the provider-retry-defaults wrapper stay in this module.
export {
  isRetryableRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  rateLimitRetryDelayMs,
  RetryAbortError,
  retryOnRateLimitError,
  sleepAbortable,
  type RateLimitRetryOptions,
};

/** Provider-default retry budget for the initial HTTP request. */
export const PROVIDER_DEFAULT_MAX_RETRIES = 5;
/** Cap for provider-requested Retry-After delays (ms). */
export const PROVIDER_DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** Account/subscription limits: not transient throttling, so they must fail
 * fast instead of being retried. */
const NON_RETRYABLE_RATE_LIMIT_PATTERN = buildPattern([
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
 * failure worth retrying. Quota/billing exhaustion is excluded so
 * deterministic failures fail fast. */
export function isRetryableRateLimit(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  if (NON_RETRYABLE_RATE_LIMIT_PATTERN.test(message.errorMessage)) return false;
  return RETRYABLE_RATE_LIMIT_PATTERN.test(message.errorMessage);
}

/** Wrap a stream function so the initial HTTP request retries on transient
 * errors with backoff, enabling provider retry defaults for every LLM call. */
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
  if (
    options.maxRetries === undefined && options.maxRetryDelayMs === undefined
  ) {
    return {
      ...options,
      maxRetries: PROVIDER_DEFAULT_MAX_RETRIES,
      maxRetryDelayMs: PROVIDER_DEFAULT_MAX_RETRY_DELAY_MS,
    };
  }
  return options;
}
