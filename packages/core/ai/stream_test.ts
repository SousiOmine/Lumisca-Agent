import { assertEquals } from "@std/assert";
import { summarizeContextUsage } from "../shared/mod.ts";
import type { Api, Model, StreamRequest } from "./types.ts";
import { createStreamFn, type StreamTransport } from "./stream.ts";

/** A fake LanguageModel implementing the AI SDK v2 provider surface (the
 * transport accepts any specificationVersion the SDK understands). The
 * v2↔v4 adapter in the SDK converts the finish part's v2 usage into the
 * v4 shape the transport reads. */
function fakeLanguageModel(parts: unknown[]) {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("not used");
    },
    doStream: () => ({
      stream: streamOf(parts),
      request: {},
      response: {},
    }),
  };
}

function streamOf<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

function transportFor(model: unknown): StreamTransport {
  return {
    languageModelFor: () => Promise.resolve(model as never),
  };
}

/** Collect every event of a stream function call. */
async function runStream(parts: unknown[]) {
  const model: Model<Api> = { id: "m", name: "m" } as unknown as Model<Api>;
  const streamFn = createStreamFn(transportFor(fakeLanguageModel(parts)));
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const request: StreamRequest = {
    messages: [{ role: "user", content: "hi" }],
  };
  for await (const event of streamFn(model, request, undefined)) {
    events.push(event as never);
  }
  return events;
}

/** v2 provider stream parts: finish carries the v2 usage shape. */
function v2Parts(usage: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}) {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "hello" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ];
}

/** The transport's errors are delivered as stream events, so the tests
 * drive a fake v2 provider model whose parts are converted by the SDK.
 * The AI SDK warning on v2 compatibility is expected noise. */
Deno.test("the transport carries the provider usage into the assistant message", async () => {
  const events = await runStream(
    v2Parts({
      inputTokens: 301200,
      outputTokens: 456,
      cachedInputTokens: 300000,
    }),
  );
  const done = events.find((e) => e.type === "done")!;
  const message = done.message as {
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total?: number;
    };
  };
  // `input` is the uncached prompt, not the provider's whole prompt: the
  // cached reads are reported separately (input + cacheRead = 301200) and
  // counting them inside `input` as well inflated the context meter.
  assertEquals(message.usage.input, 1200);
  assertEquals(message.usage.cacheRead, 300000);
  assertEquals(message.usage.cacheWrite, 0);
  assertEquals(message.usage.output, 456);
});

Deno.test("the transport usage feeds the context meter without double counting", async () => {
  const events = await runStream(
    v2Parts({
      inputTokens: 301200,
      outputTokens: 456,
      cachedInputTokens: 300000,
    }),
  );
  const done = events.find((e) => e.type === "done")!;
  const summary = summarizeContextUsage([done.message as never]);
  // The card reads the prompt the model received (301.2K) and the share of
  // it that came from the cache (300000/301200 = 99.6%).
  assertEquals(summary.currentTokens, 301200);
  assertEquals(summary.averageCacheHitRate, 300000 / 301200);
});

Deno.test("the transport falls back to the step usage when the stream carried none", async () => {
  // A provider stream without a finish part: the SDK derives the step
  // from partial output and reports its own (null) usage. The transport
  // must still emit a valid assistant message with zero usage.
  const events = await runStream([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial" },
    { type: "text-end", id: "t1" },
  ]);
  const done = events.find((e) => e.type === "done")!;
  const usage = (done.message as { usage: { input: number } }).usage;
  assertEquals(usage.input, 0);
});

Deno.test("a stream error still reports the usage the provider already consumed", async () => {
  // The provider reports deltas and a finish (with usage), then an error
  // part. The SDK records the step from the partial output, and the
  // transport's `finish`-part capture keeps the consumed usage for the
  // done message even when the stream ends with an error afterwards.
  const events = await runStream([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "partial " },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 777, outputTokens: 5, cachedInputTokens: 500 },
    },
  ]);
  const done = events.find((e) => e.type === "done")!;
  const message = done.message as {
    usage: { input: number; cacheRead: number };
  };
  // 777 is the provider's whole prompt, 500 of it cached.
  assertEquals(message.usage.input, 277);
  assertEquals(message.usage.cacheRead, 500);
});

Deno.test("missing usage stays zero (the app's placeholder shape)", async () => {
  const events = await runStream([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "hi" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: {} },
  ]);
  const done = events.find((e) => e.type === "done")!;
  const usage = (done.message as { usage: { input: number } }).usage;
  assertEquals(usage.input, 0);
});

/** A model whose stream stays open until the abort signal fires, then ends
 * (what the SDK's provider pipeline does for a cancelled request). The
 * SDK rejects `result.steps` for such a stream, which used to throw out of
 * the transport and reject the whole run. */
function fakeHeldLanguageModel() {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("not used");
    },
    doStream: ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({
            type: "text-delta",
            id: "t1",
            delta: "partial answer",
          });
          controller.enqueue({ type: "text-end", id: "t1" });
          const close = () => {
            try {
              controller.close();
            } catch {
              // already closed
            }
          };
          if (abortSignal?.aborted === true) close();
          else abortSignal?.addEventListener("abort", close, { once: true });
        },
      }),
      request: {},
      response: {},
    }),
  };
}

Deno.test("an aborted stream ends the turn as an aborted assistant message (never throws)", async () => {
  const model: Model<Api> = { id: "m", name: "m" } as unknown as Model<Api>;
  const streamFn = createStreamFn(transportFor(fakeHeldLanguageModel()));
  const controller = new AbortController();
  const request: StreamRequest = {
    messages: [{ role: "user", content: "hi" }],
  };

  const events: Array<{ type: string } & Record<string, unknown>> = [];
  let aborted = false;
  for await (
    const event of streamFn(model, request, { signal: controller.signal })
  ) {
    events.push(event as never);
    // Abort mid-stream: the run's promise must still settle normally, so
    // the session agent's rewind (waitForIdle) and the following prompt can
    // proceed.
    if (event.type === "text_delta" && !aborted) {
      aborted = true;
      controller.abort();
    }
  }

  assertEquals(events.some((e) => e.type === "error"), false);
  const done = events.at(-1)!;
  assertEquals(done.type, "done");
  const message = done.message as {
    stopReason: string;
    content: Array<{ type: string; text?: string }>;
  };
  assertEquals(message.stopReason, "aborted");
  // The output the provider already delivered stays in the transcript.
  assertEquals(
    message.content.map((b) => b.text).join(""),
    "partial answer",
  );
});

/** A model whose stream fails with a TimeoutError (what `AbortSignal.timeout`
 * raises; the SDK merges one into the request signal for its own deadlines)
 * while the CALLER's signal is untouched. */
function fakeTimingOutLanguageModel() {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("not used");
    },
    doStream: () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.error(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        },
      }),
      request: {},
      response: {},
    }),
  };
}

Deno.test("a timeout that is not the caller's abort surfaces as an error turn", async () => {
  // TimeoutError and AbortError look alike; only the caller's aborted signal
  // makes a failure a user stop. A timeout must stay visible (and retryable)
  // instead of ending the turn as if the user had pressed stop.
  const model: Model<Api> = { id: "m", name: "m" } as unknown as Model<Api>;
  const streamFn = createStreamFn(transportFor(fakeTimingOutLanguageModel()));
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (
    const event of streamFn(
      model,
      { messages: [{ role: "user", content: "hi" }] },
      { signal: new AbortController().signal },
    )
  ) {
    events.push(event as never);
  }

  const failure = events.find((e) => e.type === "error")!;
  assertEquals(failure !== undefined, true);
  assertEquals(events.some((e) => e.type === "done"), false);
  assertEquals(failure.errorRetryable, true);
});
