/**
 * Lumisca's AI vocabulary: the model/provider catalog, message/content
 * shapes, the credential store, and the stream contract. The agent loop, the
 * retry policy, the UI event bridge and the database all read these shapes,
 * so they change in one place; the transport is the only part that knows a
 * provider SDK (see stream.ts).
 */

// ---- transport / api -------------------------------------------------------

/** The request APIs the app can drive; each maps to a Vercel AI SDK
 * provider factory (see lang-model.ts). */
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
  /** True when the prompt was delivered into the run that was already
   * active instead of starting its own run (see
   * SessionAgent.joinsActiveRun); absent when it started its own run. The
   * UI keeps such a prompt inside that run's turn instead of starting a
   * new one (see web's buildTurns) — the same delivery fact
   * NotificationMessage carries, with the same reason: a message that did
   * not start a run must not end the running turn. Not provider-facing:
   * the transport reads role and content only (see toCoreMessages). */
  steered?: boolean;
  /** Set on a prompt a routine started (see shared/routine.ts): the
   * routine's name. The UI shows it above the bubble, so the user can tell
   * a scheduled request from something they typed. Never provider-facing. */
  routine?: string;
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

/** The message union the app converts to LLM messages. */
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

/** The transcript message: the three conversational roles plus the mode,
 * notification, context and checkpoint roles the agent loop injects. */
export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | ModeMessage
  | NotificationMessage
  | ContextMessage
  | CheckpointMessage;

/** A user message generated by an agent mode (e.g. review). The UI renders
 * it with a short text + mode badge instead of the full prompt text; the
 * LLM sees `fullPrompt` plus the attached images (see toLlmMessages in
 * types/notification.ts, and buildModeMessage in types/mode-message.ts for
 * the constructor). */
export interface ModeMessage {
  role: "mode";
  modeId: string;
  optionId: string;
  modeLabel: string;
  /** Short text shown by the UI (and used as the goal text for "/goal"). */
  shortText: string;
  /** The full prompt sent to the LLM (via toLlmMessages). */
  fullPrompt: string;
  /** Images the user attached in the composer, sent to the LLM after the
   * full prompt (the mode counterpart of a user message's image blocks;
   * empty when none were attached). The UI renders them in the bubble like
   * a user message's, and the rewind action restores them to the
   * composer. */
  images: ImageContent[];
  /** True when the mode prompt was delivered into the run that was already
   * active instead of starting its own run (see
   * SessionAgent.promptWhileRunning); absent when it started its own run.
   * The UI keeps such a prompt inside that run's turn instead of starting
   * a new one (see web's buildTurns) — the same delivery fact
   * NotificationMessage carries, with the same reason: a message that did
   * not start a run must not end the running turn. */
  steered?: boolean;
  timestamp: number;
}

/** Kind of a system notification injected into an agent loop: background
 * command completions (async_bash), sub-agent task completions (task),
 * agent-to-agent messages (send_message), empty-response retries (the
 * session agent retries a response that produced neither text nor a tool
 * call), and the loop's own advisories (the repeat guard's reminder — see
 * ai/agent.ts). */
export type NotificationKind =
  | "background"
  | "task"
  | "message"
  | "retry"
  /** An advisory the loop or the session agent appends to the transcript
   * itself — the repeat guard's reminder (see ai/agent.ts) — rather than a
   * completion delivered from outside. */
  | "notice";

/** Outcome of the event a notification reports. The UI shows a check for
 * success, an error badge for failure, and nothing for neutral. */
export type NotificationStatus = "success" | "error" | "neutral";

/** A system notification delivered to an agent as a first-class message
 * (injected by the session agent or steered into a sub-agent). The agent
 * sees it as a user message — see toLlmMessages — whose text starts with
 * the prefix contract taught in the system prompt ("[Background command
 * ...]", "[Task ...]", "[Message from ...]"). The UI renders it as a
 * compact one-line row instead of a user message. */
export interface NotificationMessage {
  role: "notification";
  kind: NotificationKind;
  /** Head line shown by the UI and used as the first line of the
   * agent-visible text (e.g. "[Background command #2 finished after 12s
   * (exit code 0)]"). */
  title: string;
  /** Detail text (output tail / task result / message body); empty when
   * there is nothing beyond the title. */
  body: string;
  status: NotificationStatus;
  /** True when the notification was steered into the run that was already
   * active instead of starting its own run (see
   * SessionAgent.deliverPrompt); absent when it started its own run. The UI
   * keeps a steered notification inside that run's turn instead of starting
   * a new one (see web's buildTurns): it is a system event of the ongoing
   * work, like a tool result, so it must not split the turn — the running
   * turn's work log would collapse mid-run. */
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
  /** Largest prompt the provider accepts (models.dev `limit.input`), when
   * the catalog publishes one. The window is the total the model may hold
   * including the completion, while `input` is what one request may carry:
   * a provider documenting both (OpenAI's 922,000 against a 1,050,000
   * window, for example) rejects a prompt past the smaller number, so every
   * budget in the app hangs off the smaller of the two (see
   * shared/context-usage.ts inputBudgetTokens). Undefined for the models
   * that publish no input cap. */
  maxInputTokens?: number;
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
     * `ToolResult.details`): the UI reads them for the diff badge. `{}`
     * when the result carried none. */
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
  /** Retries the AI SDK performs for the initial provider request, with its
   * own backoff (the provider's Retry-After is honoured); 0 disables the
   * loop. The agent seeds it for every LLM call — see
   * agent/llm-retry.ts. */
  maxRetries?: number;
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
