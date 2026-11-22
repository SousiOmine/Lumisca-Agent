/**
 * The stream contract: how one language-model request is issued and what
 * comes back. The only part of `ai` that knows a provider SDK lives behind
 * this interface (see stream.ts).
 */

import type { AssistantMessage, LlmMessage } from "../domain/message.ts";

import type { Api } from "../domain/model.ts";
import type { AgentTool } from "./agent-types.ts";
import type { Model, ModelThinkingLevel } from "./catalog.ts";

export type StreamEvent =
  | { type: "start"; partial?: AssistantMessage; [k: string]: unknown }
  | { type: "text_delta"; delta: string; [k: string]: unknown }
  | { type: "thinking_delta"; delta: string; [k: string]: unknown }
  | {
      type: "error";
      errorMessage?: string;
      /** Non-message detail of the failure (HTTP status, URL, body, cause
       * chain — see ai/error-detail.ts). The agent renders it beside the
       * message so a failure is diagnosable without debug logging. */
      errorDetail?: string;
      /** The provider marked the failure retryable (APICallError.isRetryable).
       * The retry policy prefers this over matching the message text. */
      errorRetryable?: boolean;
      [k: string]: unknown;
    }
  | {
      type: "toolcall_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      [k: string]: unknown;
    }
  | {
      type: "toolcall_result";
      toolCallId: string;
      toolName: string;
      content: Array<{
        type: "text" | "image";
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      /** Structured details of the result (see tools/schema.ts
       * `ToolResult.details`): the UI reads them for the diff badge. `{}`
       * when the result carried none. */
      details?: Record<string, unknown>;
      isError: boolean;
      [k: string]: unknown;
    }
  | { type: "done"; message: AssistantMessage; [k: string]: unknown };

/**
 * The stream one LLM turn yields: an async-iterable of assistant-message
 * events. Consumers (the agent runtime, `streamText`) only ever for-await
 * it, so the push/end surface is optional here — the real transport returns
 * a bare async generator. Producers that need to push events synchronously
 * use {@link PushableAssistantMessageEventStream} from event-stream.ts.
 */

export type AssistantMessageEventStream = AsyncIterable<StreamEvent> & {
  push?(event: StreamEvent): void;
  end?(message?: AssistantMessage): void;
};

export interface StreamRequest {
  systemPrompt?: string;
  messages: LlmMessage[];
  tools?: AgentTool[];
  thinkingLevel?: ModelThinkingLevel;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Retries the AI SDK performs for the initial provider request, with its
   * own backoff (the provider's Retry-After is honoured); 0 disables the
   * loop. The agent seeds it for every LLM call — see
   * ai/llm-retry.ts. */
  maxRetries?: number;
  /** Override the model's own output cap for this call (the transport sends
   * `model.maxTokens` otherwise). The compaction summarizer uses it: its
   * output is a bounded summary, and the smaller reservation is what keeps
   * the auxiliary call itself inside a request that is already near the
   * window. */
  maxOutputTokens?: number;
  /** Stable id of the conversation this request belongs to. Agent sessions
   * pass their session id; one-off auxiliary calls (title generation,
   * image analysis, judgements) pass a fresh id per call. Session-affinity
   * gateways require it — OpenCode Go rejects requests without one since
   * 2026-09-05 (sent as the x-opencode-session header, see lang-model.ts). */
  sessionId?: string;
}

/** One LLM turn (no auto tool loop): streams the model's response. The agent
 * runtime drives tool execution itself on top of this. */

export type StreamFn<TApi extends Api = Api> = (
  model: Model<TApi>,
  context: StreamRequest,
  options?: StreamOptions,
) => AssistantMessageEventStream;

// ---- agent runtime types -----------------------------------------------------------
