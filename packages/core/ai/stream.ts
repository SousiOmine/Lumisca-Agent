/**
 * The streaming transport: builds the Vercel-backed {@link StreamFn} and the
 * accumulate-text helper the auxiliary calls (title generation, image
 * analysis, goal judging, command safety) use.
 *
 * A test may inject a held-back stream function instead (see agent/faux.ts),
 * so the transport surface stays exactly one function.
 */
import {
  jsonSchema,
  stepCountIs,
  tool,
  streamText as vercelStreamText,
} from "ai";
import type { LanguageModel } from "ai";
import type {
  Api,
  AssistantMessage,
  AgentTool,
  LlmContentBlock,
  LlmMessage,
  Model,
  StreamEvent,
  StreamFn,
  StreamOptions,
  StreamRequest,
} from "./types.ts";
// (no direct event-stream imports here; streams are produced by the
// transport from the Vercel result, and consumers type them via types.ts)

/** Resolve a language model for one request (credential already resolved). */
export interface StreamTransport {
  languageModelFor(model: Model<Api>): Promise<LanguageModel | undefined>;
}

/** The reason text used when a provider is not configured. */
const NOT_CONFIGURED = (providerId: string) =>
  `Provider is not configured: ${providerId}`;

/** Build the Vercel-backed StreamFn over a transport. */
export function createStreamFn(transport: StreamTransport): StreamFn {
  return (model, context, options) =>
    runStream(model, context, options, transport);
}

/** Run one LLM turn over Vercel streamText, yielding stream events. */
async function* runStream(
  model: Model<Api>,
  context: StreamRequest,
  options: StreamOptions | undefined,
  transport: StreamTransport,
): AsyncGenerator<StreamEvent> {
  const languageModel = await transport.languageModelFor(model);
  if (languageModel === undefined) {
    yield { type: "error", errorMessage: NOT_CONFIGURED(model.provider) };
    return;
  }
  const request: Record<string, unknown> = {
    model: languageModel,
    messages: toCoreMessages(context.messages),
    ...(context.systemPrompt !== undefined
      ? { system: context.systemPrompt }
      : {}),
    ...(context.tools !== undefined && context.tools.length > 0
      ? { tools: toToolSet(context.tools) }
      : {}),
    stopWhen: stepCountIs(1),
    ...(options?.signal !== undefined ? { abortSignal: options.signal } : {}),
  };
  // Reasoning levels: map the model's stored thinking level to a Vercel
  // reasoning hint when the model documents one; leave it off otherwise so
  // providers that do not support reasoning are unaffected.
  const reasoning = reasoningHint(model, context.thinkingLevel ?? "off");
  if (reasoning !== undefined) request.reasoning = reasoning;

  const result = vercelStreamText(request as never);
  // Emit a start (empty partial) first, then text/thinking deltas as they
  // arrive; the authoritative AssistantMessage is carried by the done event.
  yield { type: "start", partial: modelStartPartial(model) };
  let text = "";
  let thinking = "";
  try {
    for await (const delta of result.textStream) {
      text += delta;
      yield { type: "text_delta", delta };
    }
    const reasoning = await result.reasoningText;
    if (reasoning !== undefined && reasoning.length > 0) {
      thinking = reasoning;
      yield { type: "thinking_delta", delta: reasoning };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "error", errorMessage: message };
    return;
  }
  const step = (await result.steps).at(-1);
  const message = buildAssistantMessage(model, step, text, thinking);
  yield { type: "done", message };
}

/** Map a Lumisca thinking level to a Vercel reasoning hint (best effort). */
function reasoningHint(
  model: Model<Api>,
  level: string,
): { enabled: boolean; effort?: string } | undefined {
  if (model.reasoning !== true) return undefined;
  const mapped = level !== "off"
    ? model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap]
    : undefined;
  const effort = mapped && mapped !== "null"
    ? mapped
    : level !== "off"
    ? { low: "low", medium: "medium", high: "high" }[level]
    : undefined;
  if (effort === undefined) {
    return level === "off" ? { enabled: false } : undefined;
  }
  return { enabled: true, effort };
}

/** An empty placeholder assistant message for the stream's start event. */
function modelStartPartial(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/** Build the final AssistantMessage from a Vercel step result. */
function buildAssistantMessage(
  model: Model<Api>,
  step: { text?: string; reasoning?: unknown; toolCalls?: unknown[] } | undefined,
  text: string,
  thinking: string,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (thinking.length > 0) {
    content.push({ type: "thinking", thinking } as never);
  }
  if (text.length > 0) {
    content.push({ type: "text", text } as never);
  }
  for (const call of step?.toolCalls ?? []) {
    const c = call as { toolCallId?: string; toolName?: string; args?: unknown };
    content.push({
      type: "toolCall",
      id: c.toolCallId ?? "",
      name: c.toolName ?? "",
      arguments: (c.args ?? {}) as Record<string, unknown>,
    } as never);
  }
  return {
    role: "assistant",
    content: content as AssistantMessage["content"],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: step && (step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** Convert Lumisca LLM messages to Vercel CoreMessage[]. */
function toCoreMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const parts = contentToParts(message.content);
    if (message.role === "assistant") {
      out.push({ role: "assistant", content: parts });
    } else if (message.role === "toolResult") {
      const m = message as unknown as {
        toolCallId: string;
        toolName: string;
        isError: boolean;
      };
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          content: resultText(message.content),
          isError: m.isError,
        }],
      });
    } else {
      out.push({ role: message.role, content: parts });
    }
  }
  return out;
}

function contentToParts(content: LlmContentBlock[]): unknown[] {
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image",
        image: `data:${block.mimeType};base64,${block.data}`,
      });
    }
    // thinking blocks are not sent to the model; toolCall blocks are only
    // present on assistant messages, handled by toCoreMessages via text parts.
  }
  return parts;
}

/** Join the text of tool-result content blocks into a plain string. */
function resultText(content: LlmContentBlock[]): string {
  const pieces: string[] = [];
  for (const block of content) {
    if (block.type === "text") pieces.push(block.text);
  }
  return pieces.join("\n");
}

/** Convert Lumisca AgentTools to a Vercel tool set (schema only — the agent
 * runtime executes tools itself so it can emit tool_start/end events). */
function toToolSet(tools: AgentTool[]): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(
        (t.parameters ?? { type: "object", properties: {} }) as never,
      ),
    });
  }
  return set;
}

// ---- accumulate-text helper -------------------------------------------------

/** Stream one request and accumulate its text deltas into a single string.
 * Throws on stream errors (the stream's message, else `failureLabel`).
 * Shared by the title generator, the image analyzer, and the safety checker.
 * Transient rate-limit (429) errors are retried with exponential backoff. */
export async function streamText(
  streamFn: StreamFn,
  model: Model<Api>,
  request: StreamRequest,
  failureLabel: string,
  options?: StreamOptions,
  retryOpts?: RateLimitRetryOptions,
): Promise<string> {
  const doAttempt = async (): Promise<string> => {
    const stream = streamFn(model, request, options);
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta;
      } else if (event.type === "error") {
        const errorEvent = event as { errorMessage?: string; error?: { errorMessage?: string } };
        throw new Error(errorEvent.errorMessage ?? errorEvent.error?.errorMessage ?? failureLabel);
      }
    }
    return text;
  };
  return await retryOnRateLimitError(doAttempt, isRetryableRateLimitError, {
    signal: options?.signal,
    ...retryOpts,
  });
}

// ---- rate-limit retry (mirrors the app's existing policy) ------------------

export interface RateLimitRetryOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  maxRetryDelayMs?: number;
  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
  /** Backoff sleep (injectable for tests); defaults to sleepAbortable. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const MAX_RATE_LIMIT_RETRIES = 5;
export const RATE_LIMIT_BASE_DELAY_MS = 2000;
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

const NON_RETRYABLE_PATTERN = buildPattern([
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
]);
const RETRYABLE_PATTERN = buildPattern([
  "rate.?limit",
  "rate_limit_exceeded",
  "too many requests",
  "\\b429\\b",
]);

function buildPattern(patterns: string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

export function isRetryableRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) return false;
  if (NON_RETRYABLE_PATTERN.test(error.message)) return false;
  return RETRYABLE_PATTERN.test(error.message);
}

export function rateLimitRetryDelayMs(attempt: number): number {
  return Math.round(
    Math.min(
      RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1),
      RATE_LIMIT_MAX_DELAY_MS,
    ) * (1 - Math.random() * 0.25),
  );
}

/** Error thrown when the backoff sleep is aborted, so callers can normalize
 * an abort during backoff to their own terminal/aborted state. */
export class RetryAbortError extends Error {
  constructor() {
    super("Aborted during rate-limit retry backoff");
    this.name = "RetryAbortError";
  }
}

/** Sleep that rejects with RetryAbortError when `signal` fires. */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new RetryAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryOnRateLimitError<T>(
  attempt: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  opts: RateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  const sleepFn = opts.sleep ?? sleepAbortable;
  let lastError: unknown;
  for (let n = 0;; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (opts.signal?.aborted) throw new RetryAbortError();
      if (n >= maxRetries || !isRetryable(error)) throw error;
      lastError = error;
      const delayMs = rateLimitRetryDelayMs(n + 1);
      opts.onRetry?.(n + 1, maxRetries, delayMs);
      try {
        await sleepFn(delayMs, opts.signal);
      } catch {
        throw lastError;
      }
    }
  }
}
