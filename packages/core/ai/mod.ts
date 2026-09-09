/**
 * Public surface of the Lumisca AI layer (the replacement for pi-ai and
 * pi-agent-core). The rest of the app imports types and helpers from here.
 */
export {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "./event-stream.ts";
export {
  createStreamFn,
  isRetryableRateLimitError,
  type RateLimitRetryOptions,
  reasoningForceOption,
  retryOnRateLimitError,
  streamText,
  type StreamTransport,
} from "./stream.ts";
export { languageModelFor, type ResolvedApiKey } from "./lang-model.ts";
export { Agent, type AgentDefaults, type AgentInit } from "./agent.ts";
export { LumiscaModels, type LumiscaModelsOptions } from "./models.ts";
export {
  fauxAssistantMessage,
  type FauxProvider,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "./faux.ts";
export type {
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
  AuthNotice,
  AuthPrompt,
  AuthPromptOption,
  AuthType,
  Credential,
  CredentialInfo,
  CredentialStore,
  ImageContent,
  LlmContentBlock,
  LlmMessage,
  Message,
  Model,
  ModelCost,
  ModelsStore,
  ModelsStoreEntry,
  ModelThinkingLevel,
  ModeMessage,
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
