import type { Message, ToolCall } from "@earendil-works/pi-ai";

/** Shared domain types; single source of truth in packages/core. */
import type {
  AgentMessage,
  AskAnswer,
  AskQuestion,
  BackgroundCommandInfo,
  ClientEvent as CoreClientEvent,
  ConnectionEntry,
  McpInfo,
  McpServerInfo,
  ModelInfo,
  NotificationKind,
  NotificationMessage,
  NotificationStatus,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginEvent,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
  SessionInfo,
  SubagentStatus,
  SubagentType,
  TaskInfo,
  ThemeSetting,
  ThinkingLevel,
  TodoPhase,
  TodoStatus,
  TodoTask,
  UserProviderInput,
  UserProviderSummary,
  Workspace,
  WorkspaceFileEntry,
} from "@lumisca/core";
export type {
  AgentMessage,
  AskAnswer,
  AskQuestion,
  BackgroundCommandInfo,
  ConnectionEntry,
  McpInfo,
  McpServerInfo,
  ModelInfo,
  NotificationKind,
  NotificationMessage,
  NotificationStatus,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginEvent,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
  SessionInfo,
  SubagentStatus,
  SubagentType,
  TaskInfo,
  ThemeSetting,
  ThinkingLevel,
  TodoPhase,
  TodoStatus,
  TodoTask,
  UserProviderInput,
  UserProviderSummary,
  Workspace,
  WorkspaceFileEntry,
};

export type ClientEvent = CoreClientEvent;

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

/** One pending ask (the `ask` tool): questions awaiting the user's answers,
 * tied to the tool call that asked them. */
export interface PendingQuestion {
  toolCallId: string;
  questions: AskQuestion[];
}

/** One sub-agent task (the `task` tool) as shown in the tasks panel. The
 * live response text is accumulated from `task_delta` events while the
 * task runs, and seeded from the resync snapshot's tail. */
export interface TaskView {
  agentId: string;
  subagentType: SubagentType;
  description: string;
  status: SubagentStatus;
  liveText: string;
}

/** One background command (the async_bash tool) as shown in the background
 * panel: the command's info plus the live output text accumulated from
 * `background_delta` events while it runs (the resync snapshot seeds the
 * tail only at completion). */
export interface BackgroundView extends BackgroundCommandInfo {
  liveText: string;
}

/** Live state of one open session tab. */
export interface SessionView {
  info: SessionInfo;
  messages: AgentMessage[];
  streamingText: string;
  runningTools: Map<string, string>; // toolCallId -> toolName
  /** Questions the agent asked (ask tool) that are still waiting for the
   * user's answers; rendered above the composer, cleared when the tool
   * call resolves or the run ends. */
  pendingQuestions: PendingQuestion[];
  /** The session's todo plan (todo tool), shown in the progress panel.
   * Replaced wholesale by every `todo` event. */
  todos: TodoPhase[];
  /** The session's sub-agent tasks (task tool), shown in the tasks panel.
   * Added by `task_start`, fed by `task_delta`, settled by `task_end`; the
   * resync replaces the list from the server snapshot. */
  tasks: TaskView[];
  /** The session's background commands (async_bash tool), shown in the
   * background panel. Added by `background_start`, fed by
   * `background_delta`, settled by `background_end`; the resync replaces
   * the list from the server snapshot. */
  backgrounds: BackgroundView[];
  /** Keys (role:timestamp) of messages deleted by rewind. Kept so a later
   * resync (merge is append-only) cannot resurrect them. */
  removed: Set<string>;
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
  return {
    info,
    messages,
    streamingText: "",
    runningTools: new Map(),
    pendingQuestions: [],
    todos: [],
    tasks: [],
    backgrounds: [],
    removed: new Set(),
  };
}

export function isViewRunning(view: SessionView): boolean {
  return view.agentStartedAt !== undefined && view.agentEndedAt === undefined;
}
