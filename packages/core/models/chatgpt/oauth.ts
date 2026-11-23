/**
 * Sign in with ChatGPT (SIWC) for the ChatGPT subscription provider.
 *
 * The flow is the open-source token-sharing one: the first sign-in registers
 * a user-defined agent with `client_id=dynamic_agent_client`, the callback
 * returns the issued client ID, and every later sign-in reuses it. The host
 * identifier (`ext_agent_host_id`) is generated once per installation and
 * sent on every authorization. Tokens are exchanged at the public OpenAI
 * token endpoint and validated against OpenAI's published JWKS; inference
 * then goes to the public Responses API with the OAuth access token.
 *
 * The protocol shape lives here so a change on OpenAI's side has one place
 * to repair. Nothing in this module picks a login method: the caller does,
 * and only the browser flow (a loopback callback on 127.0.0.1) is offered.
 */

import { createLocalJWKSet, jwtVerify } from "jose";
import type { AuthInteraction } from "../../ai/catalog.ts";
import { errorMessage, isAddrInUseError } from "../../errors.ts";
import { isRecord } from "../../fs.ts";
import type { SettingsRepo } from "../../settings/repo.ts";
import { CHATGPT_HOST_ID_KEY } from "../../shared/settings-keys.ts";
import { type FetchLike, requestSignal, truncateBody } from "./http.ts";

/** Where the OAuth endpoints live. */
export const CHATGPT_AUTH_BASE = "https://auth.openai.com";

/** The public Responses API used for ChatGPT plan usage. */
export const CHATGPT_API_BASE = "https://api.openai.com/v1";

/** First-time registration entrypoint. It is not a client ID to save. */
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** The name shown to the user while they approve the agent registration. */
export const CHATGPT_AGENT_NAME = "Lumisca";

/** Audience every request and token in this flow is bound to. */
export const CHATGPT_RESOURCE = CHATGPT_API_BASE;

/** The scope that permits inference on the user's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";

/** Identity plus plan usage, in the order the authorization page expects. */
export const CHATGPT_SCOPES: readonly string[] = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  CHATGPT_PLAN_SCOPE,
];

/** How long a flow waits for the human. Kept below the bridge's 15-minute
 * idle sweep (server/login.ts) so the flow reports its own timeout instead
 * of being disposed mid-wait. */
export const CHATGPT_FLOW_TIMEOUT_MS = 10 * 60_000;

/** Refresh this long before the access token expires, so a request that
 * starts just under the wire does not fail mid-flight. */
export const CHATGPT_REFRESH_MARGIN_MS = 60_000;

const AUTHORIZE_URL = `${CHATGPT_AUTH_BASE}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_AUTH_BASE}/api/accounts/oauth/token`;
const OIDC_CONFIG_URL = `${CHATGPT_AUTH_BASE}/.well-known/openid-configuration`;
const CALLBACK_PATH = "/auth/callback";

/** Host IDs the spec accepts. A stored value outside these shapes is
 * replaced rather than trusted. */
const HOST_ID_PREFIXES = [
  "urn:uuid:",
  "urn:ietf:params:oauth:jwk-thumbprint:",
  "did:key:",
];

/** The token response, in the flow's own terms. */
export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Lifetime the server reported, in seconds. */
  expiresIn?: number;
  /** Space-separated granted scopes, when the server repeats them. */
  scope?: string;
}

/** The identity a validated ID token establishes. */
export interface ChatGptIdentity {
  /** Opaque subject identifier (`sub`); the account's stable key. */
  subject: string;
  /** The account's email, when the token carries one. */
  email?: string;
}

/** One completed sign-in, before it is stored as a credential. */
export interface ChatGptLoginResult {
  tokens: ChatGptTokens;
  /** The issued client ID of this registration. */
  clientId: string;
  /** The host identifier the registration is bound to. */
  hostId: string;
  /** Scopes the token endpoint granted. */
  scopes: readonly string[];
  identity: ChatGptIdentity;
  idToken: string;
  /** True when this run registered a new agent. */
  newRegistration: boolean;
}

/** An account already registered on this host, reused for reauthorization. */
export interface ChatGptExistingRegistration {
  clientId: string;
  /** Retained ID token, sent as `id_token_hint` to skip account selection. */
  idToken?: string;
  /** Saved email, sent as `login_hint`. */
  email?: string;
}

/** What the browser flow needs from its host. */
export interface ChatGptLoginOptions {
  fetch: FetchLike;
  hostId: string;
  /** Present when the user is reauthorizing an existing registration. */
  existing?: ChatGptExistingRegistration;
}

/** What a refresh needs: the issued client ID and the rotating refresh
 * token are both part of the grant. */
export interface ChatGptRefreshOptions {
  clientId: string;
  refreshToken: string;
  signal?: AbortSignal;
}

/** What a revocation needs. */
export interface ChatGptRevokeOptions {
  clientId: string;
  refreshToken: string;
  signal?: AbortSignal;
}

/** Read the installation's host ID, generating one before the first
 * sign-in. Restarting the app or signing in again reuses it. */
export function getOrCreateHostId(settings: SettingsRepo): string {
  const current = settings.get(CHATGPT_HOST_ID_KEY);
  if (current !== undefined && isHostId(current)) return current;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  settings.set(CHATGPT_HOST_ID_KEY, id);
  return id;
}

/** Run the browser flow: a loopback listener on 127.0.0.1 receives the
 * callback, and the code is exchanged with the issued client ID. */
export async function loginWithBrowser(
  interaction: AuthInteraction,
  options: ChatGptLoginOptions,
): Promise<ChatGptLoginResult> {
  if (interaction.method !== undefined && interaction.method !== "browser") {
    throw new Error(`unsupported ChatGPT login method: ${interaction.method}`);
  }
  const state = randomToken();
  const nonce = randomToken();
  const pkce = await createPkce();
  const callback = startCallbackServer(state);
  try {
    const clientId = options.existing?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID;
    interaction.notify({
      type: "auth_url",
      url: buildAuthorizeUrl({
        state,
        nonce,
        challenge: pkce.challenge,
        redirectUri: callback.redirectUri,
        clientId,
        hostId: options.hostId,
        ...(options.existing?.idToken !== undefined
          ? { idTokenHint: options.existing.idToken }
          : {}),
        ...(options.existing?.email !== undefined
          ? { loginHint: options.existing.email }
          : {}),
      }),
      instructions:
        "ブラウザでChatGPTにログインし、Lumiscaへのアクセスを許可してください。",
    });
    const received = await callback.waitForCallback(interaction.signal);
    const issuedClientId = options.existing?.clientId ?? received.clientId;
    if (
      issuedClientId === undefined ||
      issuedClientId === CHATGPT_DYNAMIC_CLIENT_ID
    ) {
      throw new Error(
        "ChatGPTの認可応答に発行済みのclient_idがありません。初回登録が完了していません。",
      );
    }
    if (
      options.existing !== undefined &&
      received.clientId !== undefined &&
      received.clientId !== options.existing.clientId
    ) {
      throw new Error(
        "ChatGPTの認可応答のclient_idが、保存済みの登録と一致しません。",
      );
    }
    const tokens = await exchangeAuthorizationCode(options.fetch, {
      clientId: issuedClientId,
      code: received.code,
      verifier: pkce.verifier,
      redirectUri: callback.redirectUri,
      signal: interaction.signal,
    });
    const idToken = tokens.idToken;
    if (idToken === undefined) {
      throw new Error("ChatGPTのトークン応答にIDトークンがありません。");
    }
    const identity = await validateIdToken({
      idToken,
      clientId: issuedClientId,
      nonce,
      fetch: options.fetch,
      signal: interaction.signal,
    });
    return {
      tokens,
      clientId: issuedClientId,
      hostId: options.hostId,
      scopes: splitScopes(tokens.scope ?? received.scope),
      identity,
      idToken,
      newRegistration: options.existing === undefined,
    };
  } finally {
    await callback.close();
  }
}

/** The authorization URL the browser opens. `agent_name_hint` is only sent
 * on first registration; every request carries the host ID, the resource
 * and the full scope set. */
export function buildAuthorizeUrl(input: {
  state: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
  hostId: string;
  agentName?: string;
  idTokenHint?: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  if (input.clientId === CHATGPT_DYNAMIC_CLIENT_ID) {
    url.searchParams.set(
      "agent_name_hint",
      input.agentName ?? CHATGPT_AGENT_NAME,
    );
  }
  url.searchParams.set("ext_agent_host_id", input.hostId);
  if (input.idTokenHint !== undefined) {
    url.searchParams.set("id_token_hint", input.idTokenHint);
  }
  if (input.loginHint !== undefined) {
    url.searchParams.set("login_hint", input.loginHint);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CHATGPT_SCOPES.join(" "));
  url.searchParams.set("resource", CHATGPT_RESOURCE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Exchange a refresh token for a new access token. The response carries a
 * replacement refresh token; the caller stores it. */
export async function refreshChatGptToken(
  fetchImpl: FetchLike,
  options: ChatGptRefreshOptions,
): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    resource: CHATGPT_RESOURCE,
  });
  return await postToken(fetchImpl, form, options.signal);
}

/** Revoke the renewable session. A 200 is success, including for a token
 * that was already invalid; network errors and 5xx are retried with
 * backoff. */
export async function revokeChatGptToken(
  fetchImpl: FetchLike,
  options: ChatGptRevokeOptions,
): Promise<void> {
  const config = await fetchOidcConfig(fetchImpl, options.signal);
  if (config.revocationEndpoint === undefined) {
    throw new Error("ChatGPTのOpenID設定にrevocation_endpointがありません。");
  }
  const form = new URLSearchParams({
    token: options.refreshToken,
    token_type_hint: "refresh_token",
    client_id: options.clientId,
  });
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(config.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: requestSignal(options.signal),
      });
    } catch (error) {
      lastError = new Error(
        `ChatGPTのセッション失効に失敗しました: ${errorMessage(error)}`,
      );
      if (attempt === 3) throw lastError;
      await sleep(backoffMs(attempt), options.signal);
      continue;
    }
    const text = await response.text();
    if (response.ok) return;
    lastError = new Error(
      `ChatGPTのセッション失効に失敗しました: HTTP ${response.status}: ${truncateBody(text)}`,
    );
    if (response.status < 500 || attempt === 3) throw lastError;
    await sleep(backoffMs(attempt), options.signal);
  }
  throw lastError ?? new Error("ChatGPTのセッション失効に失敗しました。");
}

/** Validate an ID token against OpenAI's JWKS and return its identity.
 * Signature, issuer, audience, expiry and the per-attempt nonce are all
 * checked; a valid token alone does not prove plan usage, which is the
 * granted scope's job. */
export async function validateIdToken(input: {
  idToken: string;
  clientId: string;
  nonce: string;
  fetch: FetchLike;
  signal?: AbortSignal;
}): Promise<ChatGptIdentity> {
  const config = await fetchOidcConfig(input.fetch, input.signal);
  const jwks = await fetchJwks(input.fetch, config.jwksUri, input.signal);
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(input.idToken, jwks, {
      issuer: config.issuer,
      audience: input.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "aud", "iss"],
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (error) {
    throw new Error(
      `ChatGPTのIDトークンを検証できませんでした: ${errorMessage(error)}`,
    );
  }
  if (payload.nonce !== input.nonce) {
    throw new Error("ChatGPTのIDトークンのnonceが一致しません。");
  }
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error("ChatGPTのIDトークンにsubがありません。");
  }
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { subject, ...(email !== undefined ? { email } : {}) };
}

/** When the tokens stop being valid (epoch ms). The server's `expires_in`
 * is authoritative; a token that carries `exp` still answers when the
 * response omitted it. A response with neither cannot be used safely. */
export function expiresAtFor(
  tokens: ChatGptTokens,
  now: number = Date.now(),
): number {
  if (tokens.expiresIn !== undefined) return now + tokens.expiresIn * 1000;
  const exp = jwtNumber(tokens.accessToken, "exp");
  if (exp !== undefined) return exp * 1000;
  throw new Error(
    "the ChatGPT token response carried no expiry (expires_in or exp)",
  );
}

/** Split a space-separated scope value; absent or blank means no scopes. */
export function splitScopes(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value.split(/\s+/).filter((scope) => scope.length > 0);
}

// --- callback ----------------------------------------------------------------

interface CallbackResult {
  code: string;
  clientId?: string;
  scope?: string;
}

interface CallbackServer {
  redirectUri: string;
  waitForCallback(signal: AbortSignal): Promise<CallbackResult>;
  close(): Promise<void>;
}

type CallbackOutcome = { result?: CallbackResult; error?: Error };

/** Start a loopback listener on 127.0.0.1. The port is chosen by the OS:
 * the spec allows any loopback port, and the same URI is sent to the
 * authorization endpoint and the token exchange. */
function startCallbackServer(state: string): CallbackServer {
  let server: BunServer | undefined;
  let settle: (outcome: CallbackOutcome) => void = () => {};
  const received = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve;
  });

  const handler = (request: Request): Response => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      return page(404, "見つかりません", "Not found");
    }
    if (url.searchParams.get("state") !== state) {
      return page(
        400,
        "認証状態が一致しません",
        "The authentication state does not match.",
      );
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      const description = url.searchParams.get("error_description") ?? "";
      settle({
        error: new Error(
          `ChatGPTの認可が拒否されました: ${error}${
            description === "" ? "" : `: ${description}`
          }`,
        ),
      });
      return page(400, "ログインに失敗しました", "Sign-in failed.");
    }
    const code = url.searchParams.get("code");
    if (code === null) {
      return page(
        400,
        "認証コードがありません",
        "The authorization code is missing.",
      );
    }
    const clientId = url.searchParams.get("client_id") ?? undefined;
    const scope = url.searchParams.get("scope") ?? undefined;
    settle({
      result: {
        code,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(scope !== undefined ? { scope } : {}),
      },
    });
    return page(
      200,
      "ログインが完了しました",
      "Sign-in complete. You can close this tab and return to Lumisca.",
    );
  };

  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: handler,
    });
  } catch (error) {
    if (isAddrInUseError(error)) {
      throw new Error("127.0.0.1の空きポートを確保できませんでした。");
    }
    throw error;
  }
  const port = server.port;
  if (port === undefined || port === 0) {
    throw new Error(
      "ブラウザのコールバックを受け取るポートを取得できませんでした。",
    );
  }

  let closed = false;
  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    waitForCallback: (signal: AbortSignal) => waitForOutcome(received, signal),
    close: async () => {
      if (closed) return;
      closed = true;
      server.stop(true);
    },
  };
}

function waitForOutcome(
  received: Promise<CallbackOutcome>,
  signal: AbortSignal,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let done = false;
    const finish = (): boolean => {
      if (done) return true;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      return false;
    };
    const onAbort = () => {
      if (!finish()) reject(signal.reason ?? new Error("sign-in cancelled"));
    };
    const timer = setTimeout(() => {
      if (!finish()) reject(new Error("browser sign-in timed out"));
    }, CHATGPT_FLOW_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    received.then((outcome) => {
      if (finish()) return;
      if (outcome.error !== undefined) reject(outcome.error);
      else resolve(outcome.result!);
    });
  });
}

// --- token exchange ----------------------------------------------------------

async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  input: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
    signal: AbortSignal;
  },
): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    resource: CHATGPT_RESOURCE,
  });
  return await postToken(fetchImpl, form, input.signal);
}

async function postToken(
  fetchImpl: FetchLike,
  form: URLSearchParams,
  signal?: AbortSignal,
): Promise<ChatGptTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: requestSignal(signal),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `ChatGPTのトークン要求に失敗しました: ${tokenErrorMessage(text, response.status)}`,
    );
  }
  const data = parseJsonObject(text, "token response");
  const accessToken = stringField(data, "access_token");
  const refreshToken =
    typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const idToken = typeof data.id_token === "string" ? data.id_token : undefined;
  const expiresIn = numberOrUndefined(data.expires_in);
  const scope = typeof data.scope === "string" ? data.scope : undefined;
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

// --- OpenID discovery and JWKS ----------------------------------------------

interface OidcConfig {
  issuer: string;
  jwksUri: string;
  revocationEndpoint?: string;
}

async function fetchOidcConfig(
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<OidcConfig> {
  const data = await fetchJson(
    fetchImpl,
    OIDC_CONFIG_URL,
    signal,
    "OpenID設定",
  );
  const issuer = stringField(data, "issuer");
  const jwksUri = stringField(data, "jwks_uri");
  if (issuer !== CHATGPT_AUTH_BASE) {
    throw new Error(`ChatGPTのOpenID設定のissuerが想定と違います: ${issuer}`);
  }
  requireHttps(jwksUri, "jwks_uri");
  const revocationEndpoint =
    typeof data.revocation_endpoint === "string"
      ? data.revocation_endpoint
      : undefined;
  if (revocationEndpoint !== undefined) {
    requireHttps(revocationEndpoint, "revocation_endpoint");
  }
  return {
    issuer,
    jwksUri,
    ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
  };
}

async function fetchJwks(
  fetchImpl: FetchLike,
  url: string,
  signal?: AbortSignal,
): Promise<ReturnType<typeof createLocalJWKSet>> {
  const data = await fetchJson(fetchImpl, url, signal, "JWKS");
  if (!isRecord(data) || !Array.isArray(data.keys)) {
    throw new Error("ChatGPTのJWKSにkeysがありません。");
  }
  try {
    return createLocalJWKSet(
      data as unknown as Parameters<typeof createLocalJWKSet>[0],
    );
  } catch (error) {
    throw new Error(
      `ChatGPTのJWKSを読み取れませんでした: ${errorMessage(error)}`,
    );
  }
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  signal: AbortSignal | undefined,
  what: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: requestSignal(signal),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${what}の取得に失敗しました: HTTP ${response.status}: ${truncateBody(text)}`,
    );
  }
  return parseJsonObject(text, what);
}

// --- helpers ----------------------------------------------------------------

/** PKCE (S256): a random verifier and its challenge. */
async function createPkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomToken();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function randomToken(bytes: number = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function isHostId(value: string): boolean {
  return HOST_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1]!;
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jwtNumber(token: string, claim: string): number | undefined {
  const claims = jwtClaims(token);
  const value = claims?.[claim];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON: ${truncateBody(text)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return parsed;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`the response is missing "${key}"`);
  }
  return value;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function tokenErrorMessage(text: string, status: number): string {
  try {
    const data: unknown = JSON.parse(text);
    if (isRecord(data) && typeof data.error === "string") {
      const description =
        typeof data.error_description === "string"
          ? `: ${data.error_description}`
          : "";
      return `${data.error}${description}`;
    }
  } catch {
    // fall through to the raw body
  }
  return `HTTP ${status}: ${truncateBody(text)}`;
}

function requireHttps(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `ChatGPTのOpenID設定の${field}がURLではありません: ${value}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `ChatGPTのOpenID設定の${field}がhttpsではありません: ${value}`,
    );
  }
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Lumisca — ${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 48px 24px; line-height: 1.7">
<main style="max-width: 640px; margin: 0 auto">
<h1 style="font-size: 20px">${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
