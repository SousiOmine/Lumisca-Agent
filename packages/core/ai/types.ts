/**
 * Lumisca's own AI vocabulary. This module replaces the pi-ai surface the
 * application used: the model/provider catalog, message/content shapes, the
 * credential store, and the stream contract. The shapes are deliberately
 * kept structurally compatible with what the rest of the app already reads
 * (content block discriminators like "text"/"thinking"/"toolCall", the
 * AssistantMessage stopReason/usage fields, ...) so the agent loop, the
 * retry policy, the UI event bridge and the database keep working — only the
 * import sites and the transport change (Vercel AI SDK now backs the calls).
 *
 * No pi-ai dependency lives here.
 */

// ---- transport / api -------------------------------------------------------

/** The request APIs the app can drive. A subset of pi-ai's KnownApi; each
 * maps to a Vercel AI SDK provider factory (see lang-model.ts). */
export type Api =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "mistral-conversations"
  | "azure-openai-responses"
  | "bedrock-converse-stream"
  | string;

// ---- thinking levels -------------------------------------------------------

export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<
  Record<ModelThinkingLevel, string | null>
>;

// ---- content blocks ----------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  namespace?: string;
}

export type AssistantMessageContent =
  (TextContent | ThinkingContent | ToolCall)[];

// ---- usage / cost ----------------------------------------------------------

export interface Usage {
  /** Prompt tokens that neither hit the prompt cache nor were written to
   * it. A prompt is `input + cacheRead + cacheWrite` tokens wide — the
   * three parts are reported (and priced) separately by the provider. */
  input: number;
  output: number;
  /** Prompt tokens the provider served from its prompt cache. */
  cacheRead: number;
  /** Prompt tokens the provider wrote into its prompt cache. */
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoningTokens?: number;
  /** Financial cost of the usage, when the provider reports/derives it. */
  cost?: number;
  /** Total tokens of the turn as the provider reports them
   * (prompt + completion), when they are known. */
  total?: number;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---- messages ----------------------------------------------------------------

export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantMessageContent;
  api: Api;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** True when the provider marked the failure retryable (the AI SDK's
   * `APICallError.isRetryable`). Persisted with the message so a post-mortem
   * can tell a transient cut from a permanent rejection. */
  errorRetryable?: boolean;
  rawStopReason?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  usage?: Usage;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

/** The pi-ai message union the app converts to LLM messages. */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type LlmContentBlock = TextContent | ImageContent | ThinkingContent;

/** A message as handed to the LLM transport (not yet provider-specific).
 * The content blocks are the assistant's own union too: an assistant turn
 * carries tool calls, and the transport serializes them (`toCoreMessages`
 * maps a toolCall block to the provider's tool-call part). */
export interface LlmMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | (LlmContentBlock | ToolCall)[];
  timestamp?: number;
}

// ---- agent message (the transcript, incl. Lumisca extras) --------------------

/** The Lumisca transcript message: the pi-ai union plus the mode,
 * notification, context and checkpoint roles the agent loop injects. */
export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | ModeMessage
  | NotificationMessage
  | ContextMessage
  | CheckpointMessage;

export interface ModeMessage {
  role: "mode";
  modeId: string;
  optionId: string;
  modeLabel: string;
  /** Short text shown by the UI (and used as the goal text for "/goal"). */
  shortText: string;
  /** The full prompt sent to the LLM (via toLlmMessages). */
  fullPrompt: string;
  timestamp: number;
}

export interface NotificationMessage {
  role: "notification";
  kind: "background" | "task" | "message" | "retry";
  title: string;
  body: string;
  status: "success" | "error" | "neutral";
  /** True when the notification was steered into the run that was already
   * active instead of starting its own run; the UI keeps such a
   * notification inside that run's turn (see the canonical, documented
   * definition in types/notification.ts — keep the two in sync). */
  steered?: boolean;
  timestamp: number;
}

/**
 * A durable snapshot of dynamic context (agent/context-providers): the
 * session's skill catalog, or the workspace instruction files. It is
 * appended to the transcript when the underlying context changes — and only
 * then — so the model always works from the current value while the system
 * prompt stays free of per-session data (the DeepSeek Harness's
 * `PromptContext`; see toLlmMessages for the model-facing text).
 */
export interface ContextMessage {
  role: "context";
  /** Provider that published it ("skills", "instructions"). */
  provider: string;
  /** Head line: the UI row label (the body carries the framing the model
   * reads, so the title never has to be model-facing prose). */
  title: string;
  /** Model-facing text. */
  body: string;
  /** Provider-specific snapshot state, handed back to the provider's
   * `rebase()` when the transcript is re-read (session reopen, rewind) so a
   * reopened session neither republishes an unchanged value nor loses track
   * of what the history already carries. */
  state?: unknown;
  timestamp: number;
}

/**
 * A compaction checkpoint: the summary that replaced an older span of the
 * transcript to keep the conversation inside the model's request limit (see
 * agent/context-compaction.ts). It is one durable message sitting where the
 * replaced span was, so the history after a compaction reads as
 * checkpoint → retained recent messages.
 *
 * The replacement is how the DeepSeek Harness's compaction seam makes a
 * summary durable: the summary rides on an ordinary model-facing message
 * (`user/message` with a checkpoint source there; here a role of its own,
 * which also keeps it out of the user-message path in the UI) instead of
 * being an append-only note the model would read as new input.
 */
export interface CheckpointMessage {
  role: "checkpoint";
  /** Head line: the UI row label, carrying what was replaced (the model
   * never reads it — the body is the model-facing text). */
  title: string;
  /** Model-facing text: the checkpoint preamble plus the framed summary,
   * sent as ONE user message (see toLlmMessages). */
  body: string;
  timestamp: number;
}

// ---- tool definition ----------------------------------------------------------

/** The app's tool type (independent of the transport). Converted to a Vercel
 * tool by the agent adapter (agent/tool.ts). */
export interface Tool<P = unknown> {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: unknown;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: P,
    signal?: AbortSignal,
  ) => Promise<{ content: (TextContent | ImageContent)[]; details: unknown }>;
}

/** The tool type the agent runtime owns (a Lumisca agent tool). */
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
}

// ---- model / provider ----------------------------------------------------------

export interface ModelCompat {
  maxTokensField?: string;
  supportsDeveloperRole?: boolean;
  supportsStore?: boolean;
  supportsReasoningEffort?: boolean;
  supportsLongCacheRetention?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: string;
  sessionAffinityFormat?: string;
  forceAdaptiveThinking?: boolean;
  supportsTemperature?: boolean;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: ThinkingLevelMap;
  headers?: Record<string, string>;
  compat?: ModelCompat;
}

export interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: ProviderHeaders;
  readonly auth: ProviderAuth;
  getModels(): readonly Model<TApi>[];
  /** Resolve the credential for one request. Used by the transport to build a
   * Vercel provider with the right apiKey. */
  resolveCredential(context: {
    credential?: Credential;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }): Promise<
    | { auth: { apiKey: string }; source?: string }
    | undefined
  >;
  /** Optional stream function owned by the provider (used by test doubles
   * such as the faux provider to intercept LLM calls). When set, requests
   * for this provider's models route through it instead of the Vercel
   * transport. */
  customStream?: StreamFn;
}

export type ProviderHeaders = Record<string, string | null>;

export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
}

export interface ApiKeyAuth {
  name: string;
  /** Interactive login (used mostly for the settings UI). */
  login?(interaction: AuthInteraction): Promise<Credential>;
  resolve(context: {
    credential?: Credential;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }): Promise<
    | { auth: { apiKey: string }; source?: string }
    | undefined
  >;
}

export interface OAuthAuth {
  name: string;
  login(interaction: AuthInteraction): Promise<Credential>;
}

// ---- credentials -------------------------------------------------------------

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

export interface OAuthCredential {
  type: "oauth";
  token: string;
  /** Provider-issued refresh token, when present. */
  refreshToken?: string;
  /** When the token expires (epoch ms). */
  expiresAt?: number;
}

export type Credential = ApiKeyCredential | OAuthCredential;

export interface CredentialInfo {
  providerId: string;
  type: Credential["type"];
}

export interface CredentialStore {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}

// ---- auth interaction (login flows) ---------------------------------------------

export type AuthType = "oauth" | "api_key";

export interface AuthCheck {
  source: string;
  type: Credential["type"];
}

export interface AuthPromptOption {
  id: string;
  label: string;
}

export type AuthPrompt =
  | {
    type: "secret";
    message: string;
    placeholder?: string;
    signal?: AbortSignal;
  }
  | {
    type: "text";
    message: string;
    placeholder?: string;
    signal?: AbortSignal;
  }
  | {
    type: "manual_code";
    message: string;
    placeholder?: string;
    signal?: AbortSignal;
  }
  | {
    type: "select";
    message: string;
    options: readonly AuthPromptOption[];
    signal?: AbortSignal;
  };

/** A login-flow notice (device code, auth URL, info, progress). Common
 * Fields are typed for the server bus; provider-specific extras ride
 * the index signature. */
export type AuthNotice = {
  type: string;
  title?: string;
  body?: string;
  url?: string;
  message?: string;
  userCode?: string;
  verificationUri?: string;
  instructions?: string;
  deviceCode?: string;
  [key: string]: unknown;
};

/** Alias kept for the server login bridge. */
export type AuthEvent = AuthNotice;

/** Bridges one login flow to whoever drives the UI. */
export interface AuthInteraction {
  /** Prompt the user for input (a secret/plain value, or a select option
   * id). Throws when the login was cancelled. */
  prompt(input: AuthPrompt): Promise<string>;
  /** Tell the UI what to do next (open a URL, poll for a device code). */
  notify(input: AuthNotice): void;
  /** Abort the flow (user cancelled). */
  abort?(): void;
  signal: AbortSignal;
}

// ---- stream contract ----------------------------------------------------------

/** An assistant-message stream event. Extra fields are tolerated so
 * test doubles/tools that carry provider-specific metadata still satisfy
 * the union (the consumers only read the discriminated fields). */
export type StreamEvent =
  | { type: "start"; partial?: AssistantMessage; [k: string]: unknown }
  | { type: "text_delta"; delta: string; [k: string]: unknown }
  | { type: "thinking_delta"; delta: string; [k: string]: unknown }
  | { type: "toolcall_delta"; delta: string; [k: string]: unknown }
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
    content: Array<
      {
        type: "text" | "image";
        text?: string;
        data?: string;
        mimeType?: string;
      }
    >;
    /** Structured details of the result (see tools/schema.ts
     * `ToolResult.details`): the UI reads them for the diff badge and the
     * deliverables panel. `{}` when the result carried none. */
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
  maxRetries?: number;
  maxRetryDelayMs?: number;
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

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "message_start"; message: AgentMessage }
  | {
    type: "message_update";
    assistantMessageEvent:
      | { type: "text_delta"; delta: string }
      | { type: "thinking_delta"; delta: string }
      | { type: "toolcall_delta"; delta: string };
  }
  | { type: "message_end"; message: AgentMessage }
  | {
    type: "tool_execution_start";
    toolCallId: string;
    toolName: string;
    args: unknown;
  }
  | {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }
  | { type: "turn_end"; message: AgentMessage }
  | { type: "agent_end"; message?: AssistantMessage };

export interface AgentState {
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  messages: AgentMessage[];
  thinkingLevel: ModelThinkingLevel;
  isStreaming: boolean;
  errorMessage?: string;
}

// ---- models collection ------------------------------------------------------------

export interface CreateModelsOptions {
  credentials?: CredentialStore;
  modelsStore?: ModelsStore;
}

export interface ModelsStore {
  read(providerId: string): Promise<ModelsStoreEntry | undefined>;
  write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export interface ModelsStoreEntry {
  models: Array<{ id: string; name: string }>;
  refreshedAt: number;
}

export interface Models {
  setProvider(provider: Provider): void;
  deleteProvider(providerId: string): void;
  getProvider(providerId: string): Provider | undefined;
  getProviders(): readonly Provider[];
  getModel(providerId: string, modelId: string): Model | undefined;
  getModels(providerId?: string): readonly Model[];
  getAuth(providerId: string): Promise<Credential | undefined>;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  streamFn?: StreamFn;
}
