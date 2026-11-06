/**
 * The core's public surface.
 *
 * It is the runtime the server embeds and the shapes it returns: nothing
 * else. A name belongs here only when a consumer outside the package imports
 * it — the server, the web bundle (types only; see browser-entries.ts for
 * what reaches the browser at runtime) or a script. Everything the core uses
 * internally is reached through its own module, so an internal change stays
 * internal.
 *
 * The rule is enforced by a test (repo_hygiene_test.ts): an export nothing
 * imports fails, and so does a consumer import of a name that is not here.
 */
export { type CreateSessionInput, LumiscaCore } from "./core.ts";
export { LumiscaDb } from "./db/mod.ts";
export { vacuumOnStartup } from "./db/vacuum.ts";
export { createVmManager } from "./vm/container.ts";
export type {
  PushSubscriptionKeys,
  PushSubscriptionRecord,
} from "./shared/push.ts";
export { type PushMessage, sendPush } from "./notify/web-push.ts";
export type { VapidKeys } from "./notify/vapid.ts";
export type { StellaAvailability } from "./vm/availability.ts";
export { VM_CONTAINER_DIR_NAME } from "./vm/contract.ts";
export { CoreError, errorMessage } from "./errors.ts";
export { base64ToBytes } from "./base64.ts";
export { createLogger } from "./log.ts";
export type { StellaAgent } from "./stella/agents.ts";
export type { WindowQuery } from "./session/transcript-window.ts";
export { refreshCatalogInBackground } from "./models/catalog-refresh.ts";
export { Sandbox } from "./workspace/sandbox.ts";
export {
  isDirectory,
  listWorkspaceFiles,
  suggestWorkspaceFiles,
  type WorkspaceFileEntry,
} from "./workspace/files.ts";
export type { Workspace } from "./types/workspace.ts";
export type { SessionInfo } from "./types/session.ts";
export type { ClientEvent } from "./types/event.ts";
export type {
  AgentMessage,
  Api,
  AssistantMessage,
  AuthCheck,
  AuthInteraction,
  AuthNotice,
  AuthPrompt,
  AuthType,
  CheckpointMessage,
  ContextMessage,
  ImageContent,
  Message,
  Model,
  ModeMessage,
  NotificationKind,
  NotificationMessage,
  NotificationStatus,
  Provider,
  StreamFn,
  StreamRequest,
  TextContent,
  ToolCall,
} from "./ai/types.ts";
export type {
  StellaConversationSnapshot,
  StellaEntry,
  StellaEvent,
  StellaHandover,
  StellaQuestion,
} from "./types/stella-conversation.ts";
export { stellaEventsOf } from "./agent/stella-stream.ts";
export type { ModePrompt } from "./types/mode-message.ts";
export { createAssistantMessageEventStream } from "./ai/event-stream.ts";
export type { AssistantMessageEventStream } from "./ai/types.ts";
export {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "./ai/faux.ts";
export { SessionAgent } from "./agent/session-agent.ts";
export { systemLanguageTags } from "./locale.ts";
export type { SkillInfo } from "./skills/discover.ts";
export type { PendingQuestion } from "./tools/ask.ts";
export { VISUALS_DIR_NAME } from "./session/visuals.ts";
export { ATTACHMENTS_DIR_NAME } from "./session/attachments.ts";
export type { BrowserBackend } from "./browser/types.ts";
export { HttpBrowserBackend } from "./browser/client.ts";
export { createComputerHost } from "./computer/host.ts";
export type {
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  Point,
  RawCapture,
  Rect,
} from "./computer/types.ts";
export type { BackgroundCommandInfo } from "./tools/background.ts";
export type { McpInfo, McpServerInfo } from "./mcp/config.ts";
export type { McpTestResult, McpTestTool } from "./mcp/service.ts";
export { MCP_OAUTH_CALLBACK_PATH } from "./mcp/oauth.ts";
export type { McpAuthSnapshot, McpAuthStatus } from "./mcp/oauth-session.ts";
export { THEME_KEY } from "./settings/repo.ts";
export { resolveSettingsPath, SETTINGS_DIR_NAME } from "./settings/path.ts";
export type { ConnectionEntry } from "./settings/connections.ts";
export { autoAnswerSelect } from "./models/interaction.ts";
export type {
  UserProviderInput,
  UserProviderSummary,
} from "./models/user-providers.ts";

// --- front-end-safe helpers the server shares with the web package ---------

export {
  contentText,
  LANGUAGE_KEY,
  nextRunAt,
  parseAcceptLanguage,
  parseLocale,
  resolveLocale,
} from "./shared/mod.ts";
export type {
  AskAnswer,
  AskQuestion,
  CatalogStatus,
  ContextUsageSummary,
  GoalInfo,
  Locale,
  ModelInfo,
  PromptFileRef,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginEvent,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
  Routine,
  SavedPrompt,
  StellaAgentSummary,
  SubagentStatus,
  SubagentType,
  TaskInfo,
  ThemeSetting,
  ThinkingLevel,
  TodoPhase,
  TodoStatus,
  TodoTask,
  WebSearchAvailableProviderView,
  WebSearchProviderForm,
  WebSearchProviderId,
  WebSearchProviderUpdate,
  WebSearchProviderView,
  WebSearchSettingsView,
  WebSearchTestView,
} from "./shared/mod.ts";
