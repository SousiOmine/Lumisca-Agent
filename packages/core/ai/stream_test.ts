import { assertEquals } from "@std/assert";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { summarizeContextUsage } from "../shared/mod.ts";
import { bytesToBase64 } from "../base64.ts";
import { MINI_PNG } from "../test-utils.ts";
import type {
  AgentTool,
  Api,
  LlmMessage,
  Model,
  StreamOptions,
  StreamRequest,
} from "./types.ts";
import { createStreamFn, type StreamTransport } from "./stream.ts";
import {
  clampMaxTokensToContext,
  CONTEXT_SAFETY_RATIO,
  CONTEXT_SAFETY_TOKENS,
  contextSafetyTokens,
  MIN_MAX_TOKENS,
} from "./budget.ts";
import { OVERFLOW_SAFETY_TOKENS } from "./output-cap-recovery.ts";
import { estimateLlmMessagesTokens } from "../shared/token-estimate.ts";

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

/** Collect every event of a stream function call (the caller may pass its
 * own request, e.g. to hand the transport tools). */
async function runStream(
  parts: unknown[],
  request: StreamRequest = { messages: [{ role: "user", content: "hi" }] },
) {
  const model: Model<Api> = { id: "m", name: "m" } as unknown as Model<Api>;
  const streamFn = createStreamFn(transportFor(fakeLanguageModel(parts)));
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const event of streamFn(model, request, undefined)) {
    events.push(event as never);
  }
  return events;
}

/** One tool call in the v2 provider stream shape. The transport hands the
 * SDK tools WITH execute functions, so the SDK itself runs the tool and
 * appends its own `tool-result` part to the stream (the real path; only
 * test doubles bypass it). */
function toolCallParts(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  return [
    { type: "tool-input-start", id: toolCallId, toolName },
    { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
    { type: "tool-input-end", id: toolCallId },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    },
  ];
}

/** The edit tool as the app defines it: one text line for the transcript,
 * and the line counts in `details` for the UI's `+3 -2` badge. */
function editTool(): AgentTool {
  return {
    name: "edit",
    label: "Edit File",
    description: "Replace text in a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "Edited a.ts" }],
        details: { addedLines: 3, removedLines: 2 },
      }),
  };
}

Deno.test("an SDK-executed tool result keeps its details", async () => {
  const events = await runStream(
    toolCallParts("t1", "edit", { path: "a.ts" }),
    {
      messages: [{ role: "user", content: "edit a.ts" }],
      tools: [editTool()],
    },
  );

  const result = events.find((e) => e.type === "toolcall_result");
  assertEquals(result?.toolCallId, "t1");
  assertEquals(result?.content, [{ type: "text", text: "Edited a.ts" }]);
  // The UI reads the structured details (the diff badge); the transport
  // must not drop them on the way to the transcript.
  assertEquals(result?.details, { addedLines: 3, removedLines: 2 });
});

// ---- tool result images ----------------------------------------------------

/** The base64 of {@link MINI_PNG}, as the read tool hands it over. */
const MINI_PNG_BASE64 = bytesToBase64(MINI_PNG);

/** The image block a tool result carries, in the app's own shape. */
const IMAGE_BLOCK = {
  type: "image" as const,
  data: MINI_PNG_BASE64,
  mimeType: "image/png",
};

/** The same image as the chat wire carries it. */
const IMAGE_URL_PART = {
  type: "image_url",
  image_url: { url: `data:image/png;base64,${MINI_PNG_BASE64}` },
};

/** An image-returning tool, as read / pdf_read_pages / the browser and
 * computer screenshots are. */
function shotTool(): AgentTool {
  return {
    name: "shot",
    label: "Shot",
    description: "Take a screenshot.",
    parameters: { type: "object", properties: {} },
    execute: () =>
      Promise.resolve({
        content: [
          { type: "text" as const, text: "[image: shot.png (67 bytes)]" },
          IMAGE_BLOCK,
        ],
        details: { bytes: 67 },
      }),
  };
}

/** The tool result message such a tool leaves in the transcript. */
function toolResultWithImage(
  toolCallId = "t1",
  toolName = "shot",
): LlmMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [
      { type: "text", text: "[image: shot.png (67 bytes)]" },
      IMAGE_BLOCK,
    ],
    details: {},
    isError: false,
    timestamp: 0,
  } as unknown as LlmMessage;
}

/** An OpenAI-compatible SSE answer carrying `text`. */
function chatAnswer(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl-image-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-image-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}` +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

type FetchLike = (input: unknown, init?: RequestInit) => Promise<Response>;

/** The chat model a compatible provider gets (see languageModelFor): the
 * app builds its compatible providers with multi-part tool content, so an
 * image block of a tool result survives as an image part of the tool
 * message. */
function compatibleChatModel(fetchFn: FetchLike, model: Model<Api>) {
  return createOpenAICompatible({
    name: model.provider,
    apiKey: "test-key",
    baseURL: model.baseUrl ?? "https://example.invalid/v1",
    supportsMultiPartToolContent: true,
    fetch: fetchFn,
  }).chatModel(model.id);
}

/** The official OpenAI chat model (api.openai.com) — the one chat transport
 * without a multi-part tool content option. */
function firstPartyChatModel(fetchFn: FetchLike, model: Model<Api>) {
  return createOpenAI({
    apiKey: "test-key",
    baseURL: model.baseUrl,
    fetch: fetchFn,
  }).chat(model.id);
}

/** Run one request through the transport and return the chat messages the
 * provider received. */
async function runToChatBody(
  model: Model<Api>,
  messages: LlmMessage[],
  buildModel: (fetchFn: FetchLike, model: Model<Api>) => unknown =
    compatibleChatModel,
  options?: StreamOptions,
): Promise<Array<Record<string, unknown>>> {
  let sentBody: Record<string, unknown> | undefined;
  const fetchFn: FetchLike = (_input, init) => {
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(chatAnswer("seen"));
  };
  const streamFn = createStreamFn({
    languageModelFor: () =>
      Promise.resolve(buildModel(fetchFn, model) as never),
  });
  for await (const _ of streamFn(model, { messages }, options)) {
    // drain
  }
  return sentBody!.messages as Array<Record<string, unknown>>;
}

/** Shorthand for the parameters the image tests share. */
function imageModel(
  overrides: Partial<Model<Api>> = {},
): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "tool-image-test",
    // An image-capable model: the transport may hand it pictures.
    input: ["text", "image"],
    ...overrides,
  } as Model<Api>;
}

/** A fake LanguageModel at the specification the installed providers use
 * (v4): `doStream` receives the prompt exactly as a provider does, so the
 * test sees what would go to the wire without emulating one provider's own
 * SSE format. */
function recordingV4LanguageModel(): { model: unknown; prompts: unknown[] } {
  const prompts: unknown[] = [];
  const model = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("not used");
    },
    doStream: (options: { prompt?: unknown }) => {
      prompts.push(options.prompt);
      return {
        stream: streamOf(v4AnswerParts("ok")),
        request: {},
        response: {},
      };
    },
  };
  return { model, prompts };
}

/** The v4 stream parts of one plain answer. */
function v4AnswerParts(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
    },
  ];
}

Deno.test("an SDK-executed tool result keeps its image blocks", async () => {
  const events = await runStream(
    toolCallParts("t1", "shot", {}),
    {
      messages: [{ role: "user", content: "screenshot" }],
      tools: [shotTool()],
    },
  );

  const result = events.find((e) => e.type === "toolcall_result");
  // The transcript (and with it the DB, the UI's thumbnails and the image
  // analysis of a text-only model) gets the tool's own content back —
  // image blocks included, not just the text around them.
  assertEquals(result?.content, [
    { type: "text", text: "[image: shot.png (67 bytes)]" },
    IMAGE_BLOCK,
  ]);
  assertEquals(result?.details, { bytes: 67 });
});

Deno.test("a tool image rides inside the tool message of a compatible model", async () => {
  const messages = await runToChatBody(
    // A gateway endpoint: what languageModelFor routes to the compatible
    // factory (the first-party OpenAI chat model is the test below).
    imageModel({ baseUrl: "https://api.example.com/v1" }),
    [toolResultWithImage()],
  );

  // The tool message itself carries the picture: the compatible provider is
  // built with supportsMultiPartToolContent (see languageModelFor), so the
  // content output reaches the wire as parts instead of a JSON string.
  const toolMessage = messages.find((m) => m.role === "tool")!;
  assertEquals(toolMessage.content, [
    { type: "text", text: "[image: shot.png (67 bytes)]" },
    IMAGE_URL_PART,
  ]);
  // No extra message: nothing follows the tool result.
  assertEquals(messages.filter((m) => m.role === "user").length, 0);
});

Deno.test("a tool image on the OpenCode gateway follows in a user message", async () => {
  // The gateway takes the compatible factory's request but forwards tool
  // messages to its upstream over gRPC, which carries text parts only: a
  // multi-part tool content is rejected with a 400 (see
  // toolResultTakesImages). The image follows in the one role every
  // provider takes one in instead.
  const messages = await runToChatBody(
    imageModel({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
    }),
    [toolResultWithImage()],
    undefined,
    // OpenCode Go's managed inference requires the conversation id header.
    { sessionId: "conv-1" },
  );

  const toolMessage = messages.find((m) => m.role === "tool")!;
  assertEquals(toolMessage.content, "[image: shot.png (67 bytes)]");
  const imageMessages = messages.filter((m) =>
    m.role === "user" && Array.isArray(m.content)
  );
  assertEquals(imageMessages.length, 1);
  assertEquals(imageMessages[0]!.content, [
    { type: "text", text: "[image from shot]" },
    IMAGE_URL_PART,
  ]);
});

Deno.test("a tool image of the OpenAI chat model follows in a user message", async () => {
  // api.openai.com's tool messages are text-only (its SDK model has no
  // multi-part option), so the picture follows in the one role every
  // provider takes an image in — instead of being dropped.
  const messages = await runToChatBody(
    imageModel({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    }),
    [toolResultWithImage()],
    firstPartyChatModel,
  );

  const toolMessage = messages.find((m) => m.role === "tool")!;
  assertEquals(toolMessage.content, "[image: shot.png (67 bytes)]");
  const imageMessage = messages.find((m) =>
    m.role === "user" && Array.isArray(m.content)
  )!;
  assertEquals(imageMessage.content, [
    { type: "text", text: "[image from shot]" },
    IMAGE_URL_PART,
  ]);
});

Deno.test("images of parallel tool results leave the tool messages contiguous", async () => {
  // Two tools answered the same assistant turn. A user message between
  // their results would split the run of tool messages a provider reads as
  // the direct answer to that turn, so both images follow the pair.
  const messages = await runToChatBody(
    imageModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" }),
    [
      toolResultWithImage("t1", "shot"),
      toolResultWithImage("t2", "read"),
    ],
    firstPartyChatModel,
  );

  assertEquals(messages.map((m) => m.role), ["tool", "tool", "user"]);
  assertEquals(messages[2]!.content, [
    { type: "text", text: "[image from shot]\n[image from read]" },
    IMAGE_URL_PART,
    IMAGE_URL_PART,
  ]);
});

Deno.test("an api that carries tool images gets them inside the tool result", async () => {
  // Anthropic / OpenAI Responses / Google / Bedrock tool results take image
  // blocks natively, so the image needs no message of its own there.
  const { model, prompts } = recordingV4LanguageModel();
  const streamFn = createStreamFn(transportFor(model));
  for await (
    const _ of streamFn(
      imageModel({ api: "anthropic-messages", provider: "fake" }),
      { messages: [toolResultWithImage()] },
      undefined,
    )
  ) {
    // drain
  }

  const prompt = prompts[0] as Array<Record<string, unknown>>;
  const toolMessage = prompt.find((m) => m.role === "tool")!;
  const [part] = toolMessage.content as Array<Record<string, unknown>>;
  // (Round-tripped through JSON: the SDK's prompt normalization carries
  // `filename` / `providerOptions` keys on every file part, undefined
  // here.)
  assertEquals(JSON.parse(JSON.stringify(part!.output)), {
    type: "content",
    value: [
      { type: "text", text: "[image: shot.png (67 bytes)]" },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: MINI_PNG_BASE64 },
      },
    ],
  });
  // No extra message: nothing follows the tool result.
  assertEquals(prompt.some((m) => m.role === "user"), false);
});

Deno.test("a text-only model is never handed a tool image", async () => {
  // The image analysis replaces the images before the transport sees them
  // (see agent/image-analysis.ts); an image that survived a failed analysis
  // must not reach a model that cannot take one — the provider would reject
  // the whole request instead of reading the text around it.
  const { model, prompts } = recordingV4LanguageModel();
  const streamFn = createStreamFn(transportFor(model));
  for await (
    const _ of streamFn(
      imageModel({
        api: "anthropic-messages",
        provider: "fake",
        input: ["text"],
      }),
      { messages: [toolResultWithImage()] },
      undefined,
    )
  ) {
    // drain
  }

  const prompt = prompts[0] as Array<Record<string, unknown>>;
  const toolMessage = prompt.find((m) => m.role === "tool")!;
  const [part] = toolMessage.content as Array<Record<string, unknown>>;
  assertEquals(part!.output, {
    type: "text",
    value: "[image: shot.png (67 bytes)]",
  });
  assertEquals(prompt.some((m) => m.role === "user"), false);
  assertEquals(JSON.stringify(prompt).includes(MINI_PNG_BASE64), false);
});

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

Deno.test("interleaved reasoning is passed back as reasoning_content", async () => {
  let sentBody: Record<string, unknown> | undefined;
  const provider = createOpenAICompatible({
    name: "reasoning-replay-test",
    apiKey: "test-key",
    baseURL: "https://example.invalid/v1",
    fetch: (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const messages = sentBody.messages as Array<Record<string, unknown>>;
      const missingReasoning = messages.some((message) =>
        message.role === "assistant" &&
        typeof message.reasoning_content !== "string"
      );
      if (missingReasoning) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "invalid_request_error",
                message:
                  "The `reasoning_content` in the thinking mode must be passed back to the API.",
              },
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      const chunks = [
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "reasoning-model",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "continued" },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "reasoning-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return Promise.resolve(
        new Response(
          `${
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
          }data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  });
  const model: Model<Api> = {
    id: "reasoning-model",
    name: "Reasoning model",
    api: "openai-completions",
    provider: "reasoning-replay-test",
    reasoning: true,
    compat: { requiresReasoningContentOnAssistantMessages: true },
  };
  const streamFn = createStreamFn(
    transportFor(provider.chatModel(model.id)),
  );
  const request: StreamRequest = {
    thinkingLevel: "high",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "legacy answer" },
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior reasoning" },
          { type: "text", text: "first answer" },
        ],
      },
      { role: "user", content: "continue" },
    ],
  };

  const events = [];
  for await (const event of streamFn(model, request, undefined)) {
    events.push(event);
  }

  const messages = sentBody?.messages as Array<Record<string, unknown>>;
  const assistants = messages.filter((message) => message.role === "assistant");
  assertEquals(assistants[0]?.content, "legacy answer");
  assertEquals(assistants[0]?.reasoning_content, "");
  assertEquals(assistants[1]?.content, "first answer");
  assertEquals(assistants[1]?.reasoning_content, "prior reasoning");
  assertEquals(events.some((event) => event.type === "error"), false);
  assertEquals(events.at(-1)?.type, "done");
});

/** A fake model that records the options the SDK hands it, so a test can
 * assert on the request the transport built. */
function recordingLanguageModel(parts: unknown[]): {
  model: unknown;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const model = {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("not used");
    },
    doStream: (options: Record<string, unknown>) => {
      calls.push(options);
      return { stream: streamOf(parts), request: {}, response: {} };
    },
  };
  return { model, calls };
}

/** A model with a window and a completion cap, like the catalog's. */
function windowedModel(contextWindow: number, maxTokens: number): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "fake",
    contextWindow,
    maxTokens,
  } as Model<Api>;
}

const USAGE = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };

Deno.test("the output cap clamp only shrinks, and never invents a cap", () => {
  // Plenty of room: the caller's cap stands.
  assertEquals(
    clampMaxTokensToContext(windowedModel(100_000, 8_000), 1_000, 8_000),
    8_000,
  );
  // A prompt that leaves less than the cap: the cap shrinks to the room.
  const model = windowedModel(10_000, 8_000);
  assertEquals(
    clampMaxTokensToContext(model, 5_000, 8_000),
    10_000 - 5_000 - CONTEXT_SAFETY_TOKENS,
  );
  // A prompt that leaves nothing: the floor keeps a usable cap.
  assertEquals(clampMaxTokensToContext(model, 20_000, 8_000), MIN_MAX_TOKENS);
  // No cap requested, no cap sent (the provider's default applies).
  assertEquals(clampMaxTokensToContext(model, 5_000, undefined), undefined);
  // No window: nothing to clamp against.
  const bare: Model<Api> = { id: "m", name: "m" } as unknown as Model<Api>;
  assertEquals(clampMaxTokensToContext(bare, 5_000, 8_000), 8_000);
});

Deno.test("the output cap clamp measures the room against the input cap", () => {
  // A model whose window counts the completion can document a smaller
  // input cap (models.dev `limit.input`); the room left for the output is
  // the cap's, because that is what providers validate the request against.
  const capped = {
    ...windowedModel(1_050_000, 128_000),
    maxInputTokens: 922_000,
  } as Model<Api>;
  const cappedPrompt = 900_000;
  const cappedWindow = 922_000;
  assertEquals(
    clampMaxTokensToContext(capped, cappedPrompt, 128_000),
    cappedWindow - cappedPrompt -
      contextSafetyTokens(cappedPrompt, cappedWindow),
  );
  // Far from the window the margin still leaves more room than the cap asks
  // for, so the requested cap stands unchanged.
  const wide = windowedModel(1_050_000, 128_000);
  const widePrompt = 500_000;
  assertEquals(
    clampMaxTokensToContext(wide, widePrompt, 128_000),
    128_000,
  );
  // A cap wider than the window never widens the room.
  const narrow = {
    ...windowedModel(10_000, 8_000),
    maxInputTokens: 40_000,
  } as Model<Api>;
  assertEquals(
    clampMaxTokensToContext(narrow, 5_000, 8_000),
    10_000 - 5_000 - CONTEXT_SAFETY_TOKENS,
  );
});

Deno.test("the clamp charges a share of a large prompt as margin", () => {
  // The reported failure, priced the way the estimate priced it: a prompt
  // of roughly 570,000 tokens on a 1,000,000 window left the model's full
  // 384,000 cap "fitting" under the old fixed 4,096 margin, and the
  // provider — which counted the real prompt at 666,931 — rejected it. The
  // proportional margin now narrows the cap by a share of the prompt, which
  // is the quantity the estimate gets wrong.
  const prompt = 570_000;
  const window = 1_000_000;
  const cap = clampMaxTokensToContext(
    windowedModel(window, 384_000),
    prompt,
    384_000,
  );
  assertEquals(
    cap,
    window - prompt - Math.ceil(prompt * CONTEXT_SAFETY_RATIO),
  );
  // The real prompt (666,931) plus that cap fits the window the provider
  // enforces (1,048,576) — the rejection does not happen.
  assertEquals((cap as number) + 666_931 <= 1_048_576, true);
});

Deno.test("the margin never takes more than half the room the prompt leaves", () => {
  // A prompt just under the window: the proportional margin would swallow
  // the remaining room entirely, leaving a cap no answer fits in. The room
  // is what must be spent, not the margin, so half of it remains.
  const window = 1_000_000;
  const prompt = 990_000;
  assertEquals(contextSafetyTokens(prompt, window), 5_000);
  assertEquals(
    clampMaxTokensToContext(windowedModel(window, 384_000), prompt, 384_000),
    5_000,
  );
});

Deno.test("the transport clamps the output cap to the room the prompt leaves", async () => {
  const { model, calls } = recordingLanguageModel(v2Parts(USAGE));
  const streamFn = createStreamFn(transportFor(model));
  const request: StreamRequest = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "x".repeat(12_000) }],
    }],
  };
  for await (
    const _ of streamFn(windowedModel(10_000, 8_000), request, undefined)
  ) {
    // drain
  }
  assertEquals(calls.length, 1);
  const promptTokens = estimateLlmMessagesTokens(request.messages);
  assertEquals(
    calls[0]!.maxOutputTokens,
    Math.min(8_000, 10_000 - promptTokens - CONTEXT_SAFETY_TOKENS),
  );
  // The clamp is below the model's own cap: the prompt really did eat the
  // room the completion would have used.
  assertEquals((calls[0]!.maxOutputTokens as number) < 8_000, true);
});

Deno.test("the transport clamps a caller's override the same way", async () => {
  const { model, calls } = recordingLanguageModel(v2Parts(USAGE));
  const streamFn = createStreamFn(transportFor(model));
  const request: StreamRequest = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "x".repeat(12_000) }],
    }],
  };
  // The compaction summarizer's smaller cap is clamped too, so its
  // auxiliary request stays inside the window.
  for await (
    const _ of streamFn(windowedModel(10_000, 8_000), request, {
      maxOutputTokens: 4_000,
    })
  ) {
    // drain
  }
  const promptTokens = estimateLlmMessagesTokens(request.messages);
  assertEquals(
    calls[0]!.maxOutputTokens,
    Math.min(4_000, 10_000 - promptTokens - CONTEXT_SAFETY_TOKENS),
  );
});

Deno.test("a request the provider rejects as too large is re-sent with a smaller cap", async () => {
  // The reported failure, end to end: the transport asks for the model's
  // full 384,000 cap, the gateway rejects prompt + completion on its
  // 1,048,576-token window, and the transport re-sends the identical prompt
  // with the room the gateway reports. The caller sees a normal turn.
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const provider = createOpenAICompatible({
    name: "overflow-recovery-test",
    apiKey: "test-key",
    baseURL: "https://example.invalid/v1",
    fetch: (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      calls++;
      if (calls === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "invalid_request_error",
                message:
                  "Upstream request failed: [invalid_request_error] This " +
                  "model's maximum context length is 1048576 tokens. " +
                  "However, you requested 1050931 tokens (666931 in the " +
                  "messages, 384000 in the completion). Please reduce the " +
                  "length of the messages or completion.",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const chunks = [
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "very well" },
            finish_reason: null,
          }],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return Promise.resolve(
        new Response(
          `${
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
          }data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  });
  const streamFn = createStreamFn(
    transportFor(provider.chatModel("m")),
  );
  const model = windowedModel(1_000_000, 384_000);
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (
    const event of streamFn(model, {
      messages: [{ role: "user", content: "x".repeat(12_000) }],
    }, undefined)
  ) {
    events.push(event as never);
  }

  assertEquals(bodies.length, 2);
  assertEquals(bodies[0]!.max_tokens, 384_000);
  assertEquals(
    bodies[1]!.max_tokens,
    1_048_576 - 666_931 - OVERFLOW_SAFETY_TOKENS,
  );
  // One turn, no error: the retry stands in for the rejected request.
  assertEquals(events.filter((event) => event.type === "start").length, 1);
  assertEquals(events.some((event) => event.type === "error"), false);
  assertEquals(events.at(-1)!.type, "done");
  const done = events.at(-1)! as unknown as {
    message: { content: Array<{ text?: string }> };
  };
  assertEquals(done.message.content[0]?.text, "very well");
});
