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
  ThemeSetting,
  ThinkingLevel,
  Workspace,
  WorkspaceFileEntry,
} from "@lumisca/core";
export type {
  AgentMessage,
  ConnectionEntry,
  McpInfo,
  McpServerInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  ThemeSetting,
  ThinkingLevel,
  Workspace,
  WorkspaceFileEntry,
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

/** An image attached in the composer before sending. `data` is a data URL
 * (used both for the preview thumbnail and, minus the header, as the
 * base64 payload sent to the server). */
export interface PendingImage {
  data: string;
  mimeType: string;
  name?: string;
}

/** Initial data served by the server's bootstrap script (/assets/initial-data.js). */
export interface InitialData {
  workspaces: Workspace[];
  theme: ThemeSetting;
}

/** Live state of one open session tab. */
export interface SessionView {
  info: SessionInfo;
  messages: AgentMessage[];
  streamingText: string;
  runningTools: Map<string, string>; // toolCallId -> toolName
  error?: string;
  /** Timestamp when agent_start fired (ms since epoch). */
  agentStartedAt?: number;
  /** Timestamp when agent_end fired (ms since epoch). */
  agentEndedAt?: number;
  /** Timestamp when the current thinking block started (ms since epoch). */
  thinkingStartAt?: number;
}

/** Fresh view state for a newly opened session tab. */
export function emptyView(
  info: SessionInfo,
  messages: AgentMessage[] = [],
): SessionView {
  return { info, messages, streamingText: "", runningTools: new Map() };
}

export function isViewRunning(view: SessionView): boolean {
  return view.agentStartedAt !== undefined && view.agentEndedAt === undefined;
}
