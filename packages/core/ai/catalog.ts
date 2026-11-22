/**
 * The model/provider catalog and the credential store: what can be called,
 * how it authenticates, and what its limits are.
 */

import type { Api } from "../domain/model.ts";
import type { ProviderLoginMethod } from "../shared/providers.ts";

import type { StreamFn } from "./transport.ts";

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

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---- messages ----------------------------------------------------------------

/** Per-model deviations from the default request shape. A field lives here
 * only once the transport reads it: what a provider needs is data about that
 * provider's model, so it belongs beside the catalog entry rather than in a
 * provider-id branch inside `ai/`. */
export interface ModelCompat {
  /** The provider rejects an assistant turn that carries tool calls without
   * a `reasoning_content` field; the transport sends an empty one (see
   * ai/stream-messages.ts emptyReasoningContentOption). */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /** The model is a reasoning model even when the SDK's id-based
   * classification says otherwise: the transport passes `forceReasoning` so
   * a reasoning hint is not dropped silently (see ai/stream.ts
   * reasoningForceOption). */
  forceReasoning?: boolean;
  /** The backend requires a top-level `instructions` value: the transport
   * sends the system prompt there (removed from `input`) and falls back to
   * this text when the call carries no system prompt. Setting it also means
   * the backend keeps no conversation state, so the transport sends
   * `store: false`. */
  instructionsFallback?: string;
  /** The provider keeps an image part inside a tool result (see
   * ai/stream-messages.ts toCoreMessages). Absent means the transport's
   * default for the api applies: the native image carriers keep it, and so
   * does the OpenAI-compatible factory, while the first-party OpenAI chat
   * model and Mistral serialize the result as JSON, so their images follow
   * in a user message of their own. */
  toolResultCarriesImages?: boolean;
  /** The provider requires a stable per-conversation id on every request,
   * under this header name. The transport sends `StreamOptions.sessionId`
   * there and fails fast when a request has none: a gateway that rejects
   * header-less requests outright would otherwise answer with a remote 400
   * that says nothing about the cause. */
  sessionHeaderName?: string;
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
  }): Promise<ResolvedAuth | undefined>;
  /** Optional stream function owned by the provider (used by test doubles
   * such as the faux provider to intercept LLM calls). When set, requests
   * for this provider's models route through it instead of the Vercel
   * transport. */
  customStream?: StreamFn;
}

export type ProviderHeaders = Record<string, string | null>;

/** What one request needs from a provider's credential. `headers` carries
 * values derived from the credential itself (the ChatGPT account id, for
 * one), which the transport merges over the provider's static headers. */

export interface ResolvedAuth {
  auth: { apiKey: string };
  source?: string;
  headers?: Record<string, string>;
}

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
  }): Promise<ResolvedAuth | undefined>;
}

export interface OAuthAuth {
  name: string;
  /** Sign-in methods the flow can run, in the order the UI offers them.
   * A provider with more than one has to be told which one to run. */
  methods: readonly ProviderLoginMethod[];
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
  /** The account the token belongs to, when the provider identifies one.
   * The ChatGPT backend requires it as the `ChatGPT-Account-Id` header; it
   * is read from the token's claims at login and carried across refreshes
   * (a refresh response need not repeat it). */
  accountId?: string;
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

/** Bridges one login flow to whoever drives the UI. */

export interface AuthInteraction {
  /** Prompt the user for input (a secret/plain value, or a select option
   * id). Throws when the login was cancelled. */
  prompt(input: AuthPrompt): Promise<string>;
  /** Tell the UI what to do next (open a URL, poll for a device code). */
  notify(input: AuthNotice): void;
  /** How the sign-in should run, when the client chose a method. The
   * server never picks one on the flow's behalf: a flow that supports more
   * than one method refuses to start without it. */
  method?: ProviderLoginMethod;
  /** Abort the flow (user cancelled). */
  abort?(): void;
  signal: AbortSignal;
}

// ---- stream contract ----------------------------------------------------------

/** An assistant-message stream event. Extra fields are tolerated so
 * test doubles/tools that carry provider-specific metadata still satisfy
 * the union (the consumers only read the discriminated fields). */
