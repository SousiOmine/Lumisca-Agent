/**
 * The web package's single import site for domain types.
 *
 * The canonical definitions live in `@lumisca/core`; the list below is the
 * one place they are re-exported, so web modules never import the core
 * barrel directly (which would also drag in runtime modules). Local
 * declarations reference them through the `core` namespace below, so the
 * list is not repeated.
 */
import type * as core from "@lumisca/core";
import type { Message, ToolCall } from "@lumisca/core";

/** Shared domain types; single source of truth in packages/core. */
export type {
  AgentMessage,
  AskAnswer,
  AskQuestion,
  BackgroundCommandInfo,
  CatalogStatus,
  CheckpointMessage,
  ClientEvent,
  ConnectionEntry,
  ContextMessage,
  GoalInfo,
  Locale,
  McpAuthSnapshot,
  McpAuthStatus,
  McpInfo,
  McpServerInfo,
  McpTestResult,
  McpTestTool,
  ModelInfo,
  ModeMessage,
  ModePrompt,
  NotificationKind,
  NotificationMessage,
  NotificationStatus,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginEvent,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
  SavedPrompt,
  SessionInfo,
  SkillInfo,
  StellaAgent,
  StellaAvailability,
  StellaConversationSnapshot,
  StellaEntry,
  StellaEvent,
  StellaHandover,
  StellaQuestion,
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
  WebSearchAvailableProviderView,
  WebSearchProviderForm,
  WebSearchProviderId,
  WebSearchProviderUpdate,
  WebSearchProviderView,
  WebSearchSettingsView,
  WebSearchTestView,
  Workspace,
  WorkspaceFileEntry,
} from "@lumisca/core";

/** The folder picker's wire shapes, the federated peers' reachability and
 * the stella machine's status are DEFINED once in
 * `@lumisca/core/shared/wire.ts` — the server that answers those endpoints
 * imports the same definitions, so a renamed field cannot pass a type check
 * on one side only. Re-exported here because web modules import their types
 * from this one file. */
export type {
  FsBreadcrumb,
  FsBrowse,
  FsEntry,
  FsPlace,
  FsPlaceKind,
  PeerStatus,
  StellaStatus,
} from "@lumisca/core/shared";

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

/** A file attached to a prompt that is not a picture (a log, an archive, a
 * document). It is not sent to the model as bytes: the server writes it into
 * the machine and tells the model its path (see core's vm/uploads.ts). */
export interface PendingFile {
  /** The name to show and the name the machine stores it under. */
  name: string;
  /** Size in bytes (the chip shows it, and the server enforces the cap). */
  size: number;
  /** The base64 payload, without the data-URL header. */
  data: string;
}

/** Initial data served by the server's bootstrap script (/assets/initial-data.js).
 * Canonical definition lives in `@lumisca/core/shared` (so the server never
 * imports from `@lumisca/web`); re-exported here for web consumers. */
export type { InitialData } from "@lumisca/core/shared";

/** One routine as the settings list shows it — the stored row plus the
 * agent's name and whether it is running now. Defined in
 * `@lumisca/core/shared/routine.ts` (the route that produces it and this
 * panel both name it). */
export type { RoutineView } from "@lumisca/core/shared";

/** One pending ask (the `ask` tool): questions awaiting the user's answers,
 * tied to the tool call that asked them. */
export interface PendingQuestion {
  toolCallId: string;
  questions: core.AskQuestion[];
}

/** One sub-agent task (the `task` tool) as shown in the tasks panel. The
 * live response text is accumulated from `task_delta` events while the
 * task runs, and seeded from the resync snapshot's tail. */
export interface TaskView {
  agentId: string;
  subagentType: core.SubagentType;
  description: string;
  status: core.SubagentStatus;
  liveText: string;
}

/** One background command (the async_bash tool) as shown in the background
 * panel: the command's info plus the live output text accumulated from
 * `background_delta` events while it runs (the resync snapshot seeds the
 * tail only at completion). */
export interface BackgroundView extends core.BackgroundCommandInfo {
  liveText: string;
}

/** Live state of one open session tab. */
export interface SessionView {
  info: core.SessionInfo;
  /** The loaded window of the transcript, oldest first (see
   * events.mergeWindow): the newest window on open, plus whatever older
   * windows the reader scrolled back to. */
  messages: core.AgentMessage[];
  /** The cursor for the window before `messages[0]`, or null at the
   * transcript's beginning. Echoed back to read further (opaque: see the
   * core's session/transcript-window.ts). */
  older: string | null;
  /** Context usage over the WHOLE transcript, as the server summarized it
   * with the snapshot (see addContextUsage in the core's shared helpers):
   * the loaded window cannot answer this, and a meter computed from it would
   * report the window's average as the session's. */
  usage: core.ContextUsageSummary;
  streamingText: string;
  runningTools: Map<string, string>; // toolCallId -> toolName
  /** Questions the agent asked (ask tool) that are still waiting for the
   * user's answers; rendered above the composer, cleared when the tool
   * call resolves or the run ends. */
  pendingQuestions: PendingQuestion[];
  /** The session's todo plan (todo tool), shown in the progress panel.
   * Replaced wholesale by every `todo` event. */
  todos: core.TodoPhase[];
  /** The session's sub-agent tasks (task tool), shown in the tasks panel.
   * Added by `task_start`, fed by `task_delta`, settled by `task_end`; the
   * resync replaces the list from the server snapshot. */
  tasks: TaskView[];
  /** The session's background commands (async_bash tool), shown in the
   * background panel. Added by `background_start`, fed by
   * `background_delta`, settled by `background_end`; the resync replaces
   * the list from the server snapshot. */
  backgrounds: BackgroundView[];
  /** The session's active goal (`/goal` mode), shown in the right-side
   * goal panel. Set by `goal_start`/`goal_progress`, cleared by
   * `goal_done`; the resync replaces it from the server snapshot. */
  goal?: core.GoalInfo;
  /** Identity keys (see `events.messageKey`) of messages deleted by rewind.
   * Kept so a later resync (merge is append-only) cannot resurrect them. */
  removed: Set<string>;
  error?: string;
  /** Timestamp when agent_start fired (ms since epoch) — or, for a view
   * that (re)connected while a run was already going, when the transcript
   * snapshot told it the run is active (see events.applyRunState). It is a
   * flag: every displayed timer is derived from the transcript's own
   * messages. */
  agentStartedAt?: number;
  /** Timestamp when agent_end fired (ms since epoch). */
  agentEndedAt?: number;
  /** Timestamp when the current thinking block started (ms since epoch). */
  thinkingStartAt?: number;
}

/** The window of a transcript a view is built from, with the summary the
 * server took over the whole of it (see SessionSnapshot, which carries more:
 * a view takes exactly these three). */
export interface TranscriptWindow {
  messages: core.AgentMessage[];
  older: string | null;
  usage: core.ContextUsageSummary;
}

/** Fresh view state for a newly opened session tab. */
export function emptyView(
  info: core.SessionInfo,
  window: TranscriptWindow,
): SessionView {
  return {
    info,
    messages: window.messages,
    older: window.older,
    usage: window.usage,
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
