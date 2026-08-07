import type { Message, ToolCall } from "@earendil-works/pi-ai";

/** Shared domain types; single source of truth in packages/core. */
import type {
  AgentMessage,
  ClientEvent as CoreClientEvent,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  Workspace,
} from "@lumisca/core";
export type { AgentMessage, ModelInfo, ProviderInfo, SessionInfo, Workspace };

/** Core events plus the dev-mode reload broadcast from the server. */
export type ClientEvent = CoreClientEvent | { type: "reload" };

/** Assistant message with text/tool-call content, for rendering. */
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
/** Tool-result message, for pairing with its assistant tool call. */
export type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
/** A tool call block inside an assistant message. */
export type ToolCallBlock = ToolCall;

/** Initial data rendered into the SSR HTML and hydrated on the client. */
export interface InitialData {
  workspaces: Workspace[];
  theme: "light" | "dark";
}

/** Live state of one open session tab. */
export interface SessionView {
  info: SessionInfo;
  messages: AgentMessage[];
  streamingText: string;
  runningTools: Map<string, string>; // toolCallId -> toolName
  error?: string;
}

/** Fresh view state for a newly opened session tab. */
export function emptyView(
  info: SessionInfo,
  messages: AgentMessage[] = [],
): SessionView {
  return { info, messages, streamingText: "", runningTools: new Map() };
}

export function isViewRunning(view: SessionView): boolean {
  return view.streamingText.length > 0 || view.runningTools.size > 0;
}
