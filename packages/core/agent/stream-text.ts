/**
 * Accumulate-text streaming helper. Backed by the Lumisca transport
 * (ai/stream.ts). Kept as its own module so the auxiliary callers (title
 * generation, image analysis, goal judging, command safety) import from one
 * stable place.
 */
export {
  isRetryableRateLimitError,
  type RateLimitRetryOptions,
  retryOnRateLimitError,
  streamText,
} from "../ai/stream.ts";
