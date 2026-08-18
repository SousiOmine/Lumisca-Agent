import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

type StreamRequest = Parameters<StreamFn>[1];
type StreamOptions = Parameters<StreamFn>[2];

/** Stream one request and accumulate its text deltas into a single string.
 * Throws on stream errors (the stream's message, else `failureLabel`).
 * Shared by the title generator, the image analyzer, and the safety checker
 * so the accumulate-text loop stays in one place. */
export async function streamText(
  streamFn: StreamFn,
  model: Model<Api>,
  request: StreamRequest,
  failureLabel: string,
  options?: StreamOptions,
): Promise<string> {
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
}
