import type { AssistantMessage } from "../ai/types.ts";
import type { StreamFn } from "../ai/types.ts";
import { isRetryableRateLimitMessage } from "../ai/rate-limit.ts";

/** Provider-default retry budget for the initial HTTP request. */
export const PROVIDER_DEFAULT_MAX_RETRIES = 5;
/** Cap for provider-requested Retry-After delays (ms). */
export const PROVIDER_DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** True when an error-stopped assistant message is a transient rate-limit
 * failure worth retrying. Quota/billing exhaustion is excluded so
 * deterministic failures fail fast. Classifies through the shared message
 * classifier (ai/rate-limit.ts) so this path and the transport-level retry
 * can never disagree. */
export function isRetryableRateLimit(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return isRetryableRateLimitMessage(message.errorMessage);
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
