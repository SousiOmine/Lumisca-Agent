/**
 * Public surface of the Lumisca AI layer (the replacement for pi-ai and
 * pi-agent-core). The rest of the app imports types and helpers from here.
 */
export {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "./event-stream.ts";
export {
  createStreamFn,
  streamText,
  isRetryableRateLimitError,
  retryOnRateLimitError,
  type RateLimitRetryOptions,
  type StreamTransport,
} from "./stream.ts";
export { languageModelFor, type ResolvedApiKey } from "./lang-model.ts";
export { Agent, type AgentDefaults, type AgentInit } from "./agent.ts";
export { LumiscaModels, type LumiscaModelsOptions } from "./models.ts";
export {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxProvider,
} from "./faux.ts";
export type {
  AuthNotice,
  AuthPromptOption,
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  Api,
  ApiKeyAuth,
  ApiKeyCredential,
  AssistantMessage,
  AssistantMessageContent,
  AuthCheck,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Credential,
  CredentialInfo,
  CredentialStore,
  ImageContent,
  LlmContentBlock,
  LlmMessage,
  Message,
  ModeMessage,
  Model,
  ModelCost,
  ModelThinkingLevel,
  ModelsStore,
  ModelsStoreEntry,
  NotificationMessage,
  OAuthAuth,
  OAuthCredential,
  Provider,
  ProviderAuth,
  StopReason,
  StreamEvent,
  StreamFn,
  StreamOptions,
  StreamRequest,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  ThinkingLevelMap,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./types.ts";
