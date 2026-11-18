/**
 * The agent loop's own shapes: the tool contract, the events it emits and
 * the request fingerprint it reports for prompt-cache diagnosis.
 */

import type { Api, Model, ModelThinkingLevel } from "./catalog.ts";
import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  TextContent,
} from "./message.ts";

export interface AgentTool<P = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (
    id: string,
    params: P,
    signal: AbortSignal | undefined,
  ) => Promise<{ content: (TextContent | ImageContent)[]; details: unknown }>;
  /** Release what the tool allocated for itself (see Tool.dispose). */
  dispose?: () => void;
}

// ---- model / provider ----------------------------------------------------------

/** Per-model quirks the transport has to honour. A field lives here only
 * once something reads it: an unread flag is a promise the code does not
 * keep, and every provider-specific knob added "for later" becomes a lie the
 * next reader has to verify (see the one entry below and ai/stream.ts). */

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      assistantMessageEvent:
        | { type: "text_delta"; delta: string }
        | { type: "thinking_delta"; delta: string };
    }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  /** A tool call finished running. The outcome (content, details, isError)
   * is NOT carried here: it travels as the toolResult message the agent
   * appends to the transcript and announces with `message_end` (one
   * payload, one carrier — see the web's tool-line rendering). */
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
    }
  | { type: "turn_end"; message: AgentMessage }
  | { type: "agent_end"; message?: AssistantMessage };

/** The model-visible shape of one request, reported by the agent loop for
 * every request it sends (see AgentInit.onRequest).
 *
 * The provider's prompt cache serves a request only from the prefix it
 * shares with the previous one, so the two hashes and the change reason are
 * what explains a cache-read drop: `head-changed` means the system prompt or
 * the tool schemas differ (nothing of the old prefix is reusable),
 * `history-rewritten` means the message list no longer extends the previous
 * one (compaction, rewind), and no `change` means the request is an
 * append-extension whose shared prefix is reusable. */

export interface RequestShape {
  /** FNV-1a of the system prompt and the tool schemas. */
  headHash: string;
  /** FNV-1a folded over the per-message hashes of the request. */
  messagesHash: string;
  /** Number of wire messages the request carried. */
  messageCount: number;
  /** Why this request differs from the preceding one of the same agent;
   * absent when it is an append-extension of it. */
  change?: "initial" | "head-changed" | "history-rewritten";
}

export interface AgentState {
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  messages: AgentMessage[];
  thinkingLevel: ModelThinkingLevel;
  isStreaming: boolean;
  errorMessage?: string;
}
