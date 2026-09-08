/**
 * The streaming transport: builds the Vercel-backed {@link StreamFn} and the
 * accumulate-text helper the auxiliary calls (title generation, image
 * analysis, goal judging, command safety) use.
 *
 * A test may inject a held-back stream function instead (see agent/faux.ts),
 * so the transport surface stays exactly one function.
 */
import {
  isStepCount,
  jsonSchema,
  tool,
  streamText as vercelStreamText,
} from "ai";
import type { LanguageModel } from "ai";
import { sessionHeadersFor } from "./lang-model.ts";
import type {
  Api,
  AssistantMessage,
  AgentTool,
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

/** Run one LLM turn with the Vercel AI SDK.
 *
 * Tools are passed WITH execute functions, so the SDK itself executes every
 * tool call of this turn (single step via `stopWhen: isStepCount(1)`) and
 * feeds the results back into the step — the Agent never executes tools for
 * the real transport. The multi-turn loop stays in the Agent
 * (ai/agent.ts `exchangeLoop`), which keeps per-turn control (steer, abort,
 * turn_end/retry policy, event bridge) while execution lives in the SDK.
 *
 * The generator consumes `result.fullStream` so text/thinking deltas and
 * tool-call/tool-result parts arrive interleaved in real time, then yields
 * the done event carrying the turn's AssistantMessage. */
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
      ? { tools: toExecutableToolSet(context.tools, options?.signal) }
      : {}),
    // Exactly one LLM turn per StreamFn call: the SDK executes this turn's
    // tool calls (via the execute functions above); the Agent's outer loop
    // decides whether another turn follows.
    stopWhen: isStepCount(1),
    ...(options?.signal !== undefined ? { abortSignal: options.signal } : {}),
  };
  // Reasoning levels: map the model's stored thinking level to a Vercel
  // reasoning hint when the model documents one; leave it off otherwise so
  // providers that do not support reasoning are unaffected.
  const reasoning = reasoningHint(model, context.thinkingLevel ?? "off");
  if (reasoning !== undefined) request.reasoning = reasoning;
  // Conversation affinity: providers that require a stable per-conversation
  // id (OpenCode Go's x-opencode-session) get it as a request header — the
  // SDK merges request headers over the provider factory's own headers.
  const sessionHeaders = sessionHeadersFor(model, options);
  if (sessionHeaders !== undefined) request.headers = sessionHeaders;

  const result = vercelStreamText(request as never);
  yield { type: "start", partial: modelStartPartial(model) };
  let text = "";
  let thinking = "";
  try {
    // fullStream yields every part (text/reasoning deltas, tool calls and
    // tool results) in the order they happen, so tool_execution_start
    // reaches the UI before the tool runs and tool_execution_end after.
    for await (const part of result.fullStream) {
      const p = part as {
        type?: string;
        text?: unknown;
        delta?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        input?: unknown;
        output?: unknown;
        error?: unknown;
      };
      switch (p.type) {
        case "text-delta": {
          const delta = typeof p.text === "string" ? p.text : "";
          if (delta.length === 0) break;
          text += delta;
          yield { type: "text_delta", delta };
          break;
        }
        case "reasoning-delta": {
          const delta = typeof p.text === "string" ? p.text : "";
          if (delta.length === 0) break;
          thinking += delta;
          yield { type: "thinking_delta", delta };
          break;
        }
        case "tool-input-delta": {
          const delta = typeof p.delta === "string" ? p.delta : "";
          if (delta.length === 0) break;
          yield { type: "toolcall_delta", delta };
          break;
        }
        case "tool-call": {
          yield {
            type: "toolcall_start",
            toolCallId: String(p.toolCallId ?? ""),
            toolName: String(p.toolName ?? ""),
            args: toArgsRecord(p.input),
          };
          break;
        }
        case "tool-result": {
          yield {
            type: "toolcall_result",
            toolCallId: String(p.toolCallId ?? ""),
            toolName: String(p.toolName ?? ""),
            content: [{ type: "text" as const, text: outputText(p.output) }],
            isError: false,
          };
          break;
        }
        case "tool-error": {
          yield {
            type: "toolcall_result",
            toolCallId: String(p.toolCallId ?? ""),
            toolName: String(p.toolName ?? ""),
            content: [{
              type: "text" as const,
              text: errorText(p.error),
            }],
            isError: true,
          };
          break;
        }
        case "error": {
          const message = p.error instanceof Error
            ? p.error.message
            : typeof p.error === "string"
            ? p.error
            : "The model stream produced an error";
          yield { type: "error", errorMessage: message };
          return;
        }
        default:
          break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "error", errorMessage: message };
    return;
  }

  // Single-step run: the (only) step carries this turn's text, tool calls
  // (already executed by the SDK — see the tool-result parts above) and
  // finish reason for the Agent's event bridge.
  const steps = (await result.steps) as unknown as Array<{
    text?: string;
    reasoningText?: string;
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      /** v7 field name for the model-generated arguments. */
      input?: unknown;
      /** Pre-v7 field name (kept as a fallback for test doubles). */
      args?: unknown;
    }>;
  }>;
  const lastStep = steps.at(-1);
  // Prefer the streamed text (fullStream already delivered every delta);
  // fall back to the step text when the stream carried none (e.g. a cached
  // or non-streaming provider path).
  const finalText = text.length > 0 ? text : (lastStep?.text ?? "");
  const finalThinking = thinking.length > 0
    ? thinking
    : (lastStep?.reasoningText ?? "");
  const message = buildAssistantMessage(
    model,
    lastStep,
    finalText,
    finalThinking,
  );
  yield { type: "done", message };
}

/** Map a Lumisca thinking level to a Vercel reasoning hint (best effort).
 * Returns a plain string (`"high"`, etc.) or `undefined` — not an object
 * with `{ enabled, effort }` — because the `@ai-sdk/openai-compatible`
 * provider sends the whole reasoning value as `reasoning_effort`:
 *
 *   reasoning_effort = isCustomReasoning(reasoning) ? reasoning : undefined
 *
 * An object like `{ enabled: true }` or `{ enabled: false }` reaches the
 * wire as-is, which OpenCode Go / Console Go rejects since it expects a
 * string like `"low"`, `"medium"`, `"high"`, etc. */
function reasoningHint(
  model: Model<Api>,
  level: string,
): string | undefined {
  if (model.reasoning !== true) return undefined;
  if (level === "off") return undefined;
  const mapped = model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap];
  return mapped && mapped !== "null"
    ? mapped
    : ({ low: "low", medium: "medium", high: "high" } as Record<string, string>)[level];
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
  step:
    | {
      text?: string;
      reasoning?: unknown;
      toolCalls?: unknown[];
    }
    | undefined,
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
    const c = call as {
      toolCallId?: string;
      toolName?: string;
      /** AI SDK v7 field name for the model-generated arguments. */
      input?: unknown;
      /** Pre-v7 field name (kept as a fallback for test doubles). */
      args?: unknown;
    };
    content.push({
      type: "toolCall",
      id: c.toolCallId ?? "",
      name: c.toolName ?? "",
      arguments: toArgsRecord(c.input ?? c.args),
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

/** Normalize model-generated tool arguments to a plain record. Anything
 * non-object (including undefined) becomes `{}` so the transcript and the
 * UI never see a missing args object. */
function toArgsRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/** Render an SDK tool `output` (whatever the execute function returned)
 * as the transcript/display text. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null) {
    const o = output as { type?: unknown; value?: unknown; text?: unknown };
    if (typeof o.value === "string") return o.value;
    if (typeof o.text === "string" && typeof o.type === "string") {
      return o.text;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  if (output === undefined || output === null) return "Tool completed.";
  return String(output);
}

/** Render an SDK tool `error` as the transcript/display text. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Convert Lumisca LLM messages to Vercel CoreMessage[] (v7 format). */
function toCoreMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      // Tool results: Vercel v7 expects role "tool" with ToolResultPart[]
      const m = message as unknown as Record<string, unknown>;
      const toolCallId = String(m.toolCallId ?? "");
      const toolName = String(m.toolName ?? "");
      const isError = m.isError === true;
      const text = typeof m.content === "object" && Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? ""))
            .join("\n")
        : String(m.content ?? "");
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName,
          output: {
            type: isError ? "error-text" : "text",
            value: text || "Tool completed.",
          },
        }],
      });
      continue;
    }
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    // Build content parts: text + images (user), text + tool-calls (assistant)
    const parts: unknown[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({
          type: "image",
          image: `data:${block.mimeType};base64,${block.data}`,
        });
      }
    }
    for (const block of message.content as unknown[]) {
      const b = block as { type?: string };
      if (b.type === "toolCall") {
        const tc = block as Record<string, unknown>;
        parts.push({
          type: "tool-call",
          toolCallId: String(tc.id ?? ""),
          toolName: String(tc.name ?? ""),
          // Vercel v7 uses `input` (not `args`) for tool-call arguments
          input: (tc.arguments as Record<string, unknown>) ?? {},
        });
      }
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: parts.length > 0 ? parts : "",
      });
    } else {
      out.push({ role: message.role, content: parts });
    }
  }
  return out;
}

/** Convert Lumisca AgentTools to Vercel Tool objects WITH execute functions,
 * so the AI SDK executes tools instead of the Agent doing it manually.
 * Tools without `execute` (edge case) are passed as schema-only.
 * Uses `inputSchema` (Vercel v7 property name), not `parameters`. */
function toExecutableToolSet(
  tools: AgentTool[],
  signal?: AbortSignal,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const t of tools) {
    const inputSchema = jsonSchema(
      (t.parameters ?? { type: "object", properties: {} }) as never,
    );
    if (typeof t.execute === "function") {
      const exec = t.execute;
      // Cast through `never`: Vercel v7's tool() generic inference rejects
      // unknown-input tools with execute. The actual types are determined at
      // call time by the SDK, so `never` is safe here.
      set[t.name] = tool({
        description: t.description,
        inputSchema,
        execute: async (
          input: Record<string, unknown>,
          options: { toolCallId: string; abortSignal?: AbortSignal },
        ) => {
          const prepared = t.prepareArguments
            ? t.prepareArguments(input)
            : input;
          // Prefer the SDK's per-tool abort signal (covers tool timeouts);
          // fall back to the request signal when the SDK provides none.
          const toolSignal = options.abortSignal ?? signal;
          const result = await exec(
            options.toolCallId,
            prepared as never,
            toolSignal,
          );
          const text = result.content
            .filter((c): c is { type: "text"; text: string } =>
              c.type === "text"
            )
            .map((c) => c.text)
            .join("\n");
          return text;
        },
      } as never);
    } else {
      set[t.name] = tool({ description: t.description, inputSchema } as never);
    }
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
