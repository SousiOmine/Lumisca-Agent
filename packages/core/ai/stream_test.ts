import { assertEquals } from "@std/assert";
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
  assertEquals(message.usage.input, 301200);
  assertEquals(message.usage.cacheRead, 300000);
  assertEquals(message.usage.cacheWrite, 0);
  assertEquals(message.usage.output, 456);
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
  assertEquals(message.usage.input, 777);
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
