/**
 * Accumulate-text streaming helper. Backed by the Lumisca transport
 * (ai/stream.ts). Kept as its own module so the auxiliary callers (title
 * generation, image analysis, goal judging, command safety) import from one
 * stable place.
 */
export {
  streamText,
  isRetryableRateLimitError,
  retryOnRateLimitError,
  type RateLimitRetryOptions,
} from "../ai/stream.ts";
