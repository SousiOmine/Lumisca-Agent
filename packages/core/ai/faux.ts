/**
 * Test doubles for the Lumisca AI layer, replacing pi-ai's faux helpers.
 *
 * The faux {@link FauxProvider} serves a scripted queue of responses — one
 * per LLM call — so the agent loop can be driven deterministically. Each
 * queued entry is either an {@link AssistantMessage} or a response function
 * `(context, options, state, model) => AssistantMessage | Promise<AssistantMessage>`
 * (the same shape pi-ai's faux accepted), so tests can inspect the request
 * and model the provider's behavior (e.g. capture the reasoning option).
 */
import { createAssistantMessageEventStream } from "./event-stream.ts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageContent,
  Model,
  ModelThinkingLevel,
  Provider,
  StopReason,
  StreamFn,
  StreamOptions,
  StreamRequest,
  TextContent,
  ThinkingContent,
  ThinkingLevelMap,
  ToolCall,
  Usage,
} from "./types.ts";

export function fauxText(text: string): TextContent {
  return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
  return { type: "thinking", thinking };
}

export function fauxToolCall(
  name: string,
  args: Record<string, unknown>,
  id = `faux_${Math.random().toString(36).slice(2)}`,
): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

/** Build an AssistantMessage from a string or content block array. */
export function fauxAssistantMessage(
  content: string | AssistantMessageContent,
  opts: {
    stopReason?: StopReason;
    errorMessage?: string;
    /** Marks the error as provider-retryable (the AI SDK's
     * `APICallError.isRetryable`), so a test can exercise the retry policy's
     * flag branch without a real transport. */
    errorRetryable?: boolean;
    timestamp?: number;
    usage?: Usage;
  } = {},
): AssistantMessage {
  const normalized: AssistantMessageContent = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
  return {
    role: "assistant",
    content: normalized,
    api: "openai-completions",
    provider: "faux",
    model: "faux",
    usage: opts.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: opts.stopReason ?? "stop",
    errorMessage: opts.errorMessage,
    ...(opts.errorRetryable === true ? { errorRetryable: true } : {}),
    timestamp: opts.timestamp ?? Date.now(),
  };
}

/** A queued response: a ready message, or a function that produces one
 * given the request context/options/model (used to inspect requests). */
export type FauxResponse =
  | AssistantMessage
  | ((
    context: StreamRequest,
    options: StreamOptions & { reasoning?: ModelThinkingLevel },
    state: unknown,
    model: Model<Api>,
  ) => AssistantMessage | Promise<AssistantMessage>);

/** Model config the faux provider registers (subset of the Model shape). */
export interface FauxModelConfig {
  id: string;
  name?: string;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  maxTokens?: number;
  contextWindow?: number;
}

export interface FauxOptions {
  models?: FauxModelConfig[];
  /** Simulated tokens-per-second (kept for pi-ai test-source compatibility). */
  tokensPerSecond?: number;
}

export interface FauxProvider {
  provider: Provider;
  setResponses(responses: FauxResponse[]): void;
  getModel(): Model<Api>;
  streamFn: StreamFn;
}

const DEFAULT_MODEL = "faux";

function buildFauxModel(config: FauxModelConfig): Model<Api> {
  return {
    id: config.id,
    name: config.name ?? config.id,
    api: "openai-completions",
    provider: "faux",
    reasoning: config.reasoning ?? false,
    input: config.input ?? ["text"],
    thinkingLevelMap: config.thinkingLevelMap,
    maxTokens: config.maxTokens,
    contextWindow: config.contextWindow,
  };
}

/**
 * A provider whose stream function serves a scripted queue of responses,
 * one per LLM call. Tests call {@link FauxProvider.setResponses} then use
 * {@link FauxProvider.streamFn} as the agent's StreamFn.
 */
export function fauxProvider(options: FauxOptions = {}): FauxProvider {
  const configs = options.models ?? [{ id: DEFAULT_MODEL }];
  const models = configs.map(buildFauxModel);
  let queue: FauxResponse[] = [];

  const provider: Provider = {
    id: "faux",
    name: "Faux",
    getModels: () => models,
    resolveCredential: () =>
      Promise.resolve({ auth: { apiKey: "faux-key" }, source: "faux" }),
    auth: {
      apiKey: {
        name: "Faux",
        resolve: () =>
          Promise.resolve({ auth: { apiKey: "faux-key" }, source: "faux" }),
      },
    },
  };

  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const entry = queue.shift();
    if (entry === undefined) {
      stream.push({ type: "error", errorMessage: "no more faux responses" });
      stream.end();
      return stream;
    }
    const produce = typeof entry === "function"
      ? entry(
        context,
        {
          ...options,
          reasoning: context.thinkingLevel !== undefined &&
              context.thinkingLevel !== "off"
            ? context.thinkingLevel
            : undefined,
        },
        undefined,
        _model,
      )
      : entry;
    Promise.resolve(produce).then((message) => {
      // Emit start(partial) first, then text/thinking deltas (so
      // accumulate-text helpers such as streamText see the content), then
      // close. The agent reads the message from the start event's partial
      // when no done event follows.
      stream.push({ type: "start", partial: message });
      for (const block of message.content) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", delta: block.text });
        } else if (block.type === "thinking") {
          stream.push({ type: "thinking_delta", delta: block.thinking });
        }
      }
      stream.end(message);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", errorMessage: message });
    });
    return stream;
  };

  // Route requests for this provider's models through the scripted stream,
  // so a LumiscaCore built with the faux provider serves the queued
  // responses (instead of hitting a real Vercel transport).
  (provider as { customStream?: StreamFn }).customStream = streamFn;

  return {
    provider,
    setResponses(responses: FauxResponse[]): void {
      queue = [...responses];
    },
    getModel(): Model<Api> {
      return models[0]!;
    },
    streamFn,
  };
}

export { createAssistantMessageEventStream };
