import type { Message, ToolCall } from "@earendil-works/pi-ai";

/** Shared domain types; single source of truth in packages/core. */
import type {
  AgentMessage,
  ClientEvent as CoreClientEvent,
  ConnectionEntry,
  McpInfo,
  McpServerInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  ThinkingLevel,
  Workspace,
} from "@lumisca/core";
export type {
  AgentMessage,
  ConnectionEntry,
  McpInfo,
  McpServerInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  ThinkingLevel,
  Workspace,
};

export type ClientEvent = CoreClientEvent;

/** Event as received over the WebSocket: every event carries the peer id
 * of the server that produced it ("" = this server). */
export type FederatedEvent = ClientEvent & { peerId?: string };

/** A workspace as shown in the federated workspace picker: which peer owns
 * it ("" = this server) and how that peer is named. */
export interface FederatedWorkspace {
  peerId: string;
  peerName: string;
  workspace: Workspace;
}

/** Peer reachability, reported alongside the merged workspace list. */
export interface PeerStatus {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

/** Assistant message with text/tool-call content, for rendering. */
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
/** Tool-result message, for pairing with its assistant tool call. */
export type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
/** A tool call block inside an assistant message. */
export type ToolCallBlock = ToolCall;

/** Initial data served by the server's bootstrap script (/assets/initial-data.js). */
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
