import type { AssistantMessage } from "../ai/types.ts";
import type { StreamFn } from "../ai/types.ts";
import { isRetryableRateLimitMessage } from "../ai/rate-limit.ts";

/** Retry budget the agent seeds for every LLM call: the AI SDK's own retry
 * loop for the initial provider request, with the SDK's backoff (see
 * StreamOptions.maxRetries). */
export const PROVIDER_DEFAULT_MAX_RETRIES = 5;

/** True when an error-stopped assistant message is a transient rate-limit
 * failure worth retrying. Quota/billing exhaustion is excluded so
 * deterministic failures fail fast. Classifies through the shared message
 * classifier (ai/rate-limit.ts) so this path and the transport-level retry
 * can never disagree. */
export function isRetryableRateLimit(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return isRetryableRateLimitMessage(message.errorMessage);
}

/** Wrap a stream function so every LLM call carries the provider retry
 * budget (the SDK's own loop — see StreamOptions.maxRetries). */
export function withProviderRetryDefaults(base: StreamFn): StreamFn {
  return (model, context, options) =>
    base(model, context, applyProviderRetryDefaults(options));
}

/** Fill in the provider retry default when the caller left it unset. */
export function applyProviderRetryDefaults(
  options: Parameters<StreamFn>[2],
): Parameters<StreamFn>[2] {
  if (options === undefined) {
    return { maxRetries: PROVIDER_DEFAULT_MAX_RETRIES };
  }
  if (options.maxRetries === undefined) {
    return { ...options, maxRetries: PROVIDER_DEFAULT_MAX_RETRIES };
  }
  return options;
}
