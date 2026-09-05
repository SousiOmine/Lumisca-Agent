import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  isRetryableRateLimitError,
  type RateLimitRetryOptions,
  retryOnRateLimitError,
} from "./llm-retry.ts";

type StreamRequest = Parameters<StreamFn>[1];
type StreamOptions = Parameters<StreamFn>[2];

/** Stream one request and accumulate its text deltas into a single string.
 * Throws on stream errors (the stream's message, else `failureLabel`).
 * Shared by the title generator, the image analyzer, and the safety checker
 * so the accumulate-text loop stays in one place. Transient rate-limit (429)
 * errors are retried with exponential backoff (see retryOnRateLimitError) so
 * an auxiliary call recovers instead of failing the whole feature. */
export async function streamText(
  streamFn: StreamFn,
  model: Model<Api>,
  request: StreamRequest,
  failureLabel: string,
  options?: StreamOptions,
  retryOpts?: RateLimitRetryOptions,
): Promise<string> {
  const doAttempt = async (): Promise<string> => {
    const stream = await streamFn(model, request, options);
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta;
      } else if (event.type === "error") {
        throw new Error(event.error.errorMessage ?? failureLabel);
      }
    }
    return text;
  };
  return await retryOnRateLimitError(doAttempt, isRetryableRateLimitError, {
    signal: options?.signal,
    ...retryOpts,
  });
}
