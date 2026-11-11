/**
 * OAuth for the ChatGPT (Codex) backend: the device-code flow and the
 * browser flow with a loopback callback.
 *
 * Both flows end at the same token endpoint and yield the same
 * {@link ChatGptTokens}; which one runs is the client's choice (a remote
 * page cannot receive a callback on the server machine, so it asks for the
 * device code). Nothing here picks a method on its own.
 *
 * The backend is not a public API. The constants below mirror what the
 * Codex CLI sends; see ARCHITECTURE.md's ChatGPT section for the sources of
 * the shape (instructions required, store:false, ChatGPT-Account-Id).
 */
import type { AuthInteraction } from "../../ai/types.ts";
import { isRecord } from "../../fs.ts";
import {
  CHATGPT_REQUEST_TIMEOUT_MS,
  type FetchLike,
  requestSignal,
  truncateBody,
} from "./http.ts";

/** Where the OAuth endpoints live. */
export const CHATGPT_AUTH_BASE = "https://auth.openai.com";

/** The ChatGPT backend (Responses API and the model catalog). */
export const CHATGPT_API_BASE = "https://chatgpt.com/backend-api/codex";

/** Codex CLI's public OAuth client. The backend ties the token scopes and
 * the allowed redirect URIs to it. */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Identifies Lumisca to the backend (`originator` header and authorize
 * parameter). The CLI's own value is refused for third-party clients. */
export const CHATGPT_ORIGINATOR = "lumisca";

/** Where the device flow asks the user to enter the code. */
export const CHATGPT_DEVICE_VERIFICATION_URI =
  "https://auth.openai.com/codex/device";

/** Lifetime the backend gives a device code, in seconds. */
export const CHATGPT_DEVICE_CODE_LIFETIME_SECONDS = 15 * 60;

/** The callback path Codex's client registration allows. */
const CALLBACK_PATH = "/auth/callback";

/** Ports Codex's client registration allows for the loopback callback, in
 * the order they are tried (the CLI uses the same pair). */
const BROWSER_PORTS: readonly number[] = [1455, 1457];

/** How long a flow waits for the human. Kept below the bridge's 15-minute
 * idle sweep (`server/login.ts`) so the flow reports its own timeout
 * instead of being disposed mid-wait. */
export const CHATGPT_FLOW_TIMEOUT_MS = 10 * 60_000;

/** Refresh this long before the access token expires, so a request that
 * starts just under the wire does not fail mid-flight. */
export const CHATGPT_REFRESH_MARGIN_MS = 60_000;

/** The token response, in the flow's own terms. */
export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Lifetime the server reported, in seconds. */
  expiresIn?: number;
}

/** Run the device-code flow: the user opens the verification page on any
 * device and enters the code; this waits for the approval. */
export async function loginWithDeviceCode(
  interaction: AuthInteraction,
  fetchImpl: FetchLike,
): Promise<ChatGptTokens> {
  const { deviceAuthId, userCode, interval } = await requestUserCode(
    fetchImpl,
    interaction.signal,
  );

  interaction.notify({
    type: "device_code",
    userCode,
    verificationUri: CHATGPT_DEVICE_VERIFICATION_URI,
    intervalSeconds: interval,
    expiresInSeconds: CHATGPT_DEVICE_CODE_LIFETIME_SECONDS,
  });
  const { code, verifier } = await pollForApproval(
    fetchImpl,
    deviceAuthId,
    userCode,
    interval,
    interaction.signal,
  );
  return await exchangeCode(
    fetchImpl,
    code,
    verifier,
    `${CHATGPT_AUTH_BASE}/deviceauth/callback`,
    interaction.signal,
  );
}

/** Run the browser flow: a loopback listener receives the callback. */
export async function loginWithBrowser(
  interaction: AuthInteraction,
  fetchImpl: FetchLike,
): Promise<ChatGptTokens> {
  const state = randomToken();
  const pkce = await createPkce();
  const callback = startCallbackServer(state);
  try {
    interaction.notify({
      type: "auth_url",
      url: buildAuthorizeUrl({
        state,
        challenge: pkce.challenge,
        redirectUri: callback.redirectUri,
      }),
    });
    const code = await callback.waitForCode(interaction.signal);
    return await exchangeCode(
      fetchImpl,
      code,
      pkce.verifier,
      callback.redirectUri,
      interaction.signal,
    );
  } finally {
    await callback.close();
  }
}

/** The authorize URL the browser flow opens. */
export function buildAuthorizeUrl(input: {
  state: string;
  challenge: string;
  redirectUri: string;
}): string {
  const url = new URL(`${CHATGPT_AUTH_BASE}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CHATGPT_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", input.state);
  url.searchParams.set("originator", CHATGPT_ORIGINATOR);
  return url.toString();
}

/** Exchange a refresh token for a new access token. A refresh response may
 * omit the refresh token; the caller keeps the previous one then. */
export async function refreshChatGptToken(
  fetchImpl: FetchLike,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CHATGPT_CLIENT_ID,
  });
  const response = await fetchImpl(`${CHATGPT_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: signal ?? AbortSignal.timeout(CHATGPT_REQUEST_TIMEOUT_MS),
  });
  return await readTokenResponse(response);
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

/** The ChatGPT account id a token names, if any. It lives under
 * `https://api.openai.com/auth` (the Codex CLI's location) or at the top
 * level; an id token and an access token both carry it. */
export function chatGptAccountId(token: string): string | undefined {
  const claims = jwtClaims(token);
  if (claims === undefined) return undefined;
  const auth = claims["https://api.openai.com/auth"];
  if (isRecord(auth) && typeof auth.chatgpt_account_id === "string") {
    return auth.chatgpt_account_id;
  }
  return typeof claims.chatgpt_account_id === "string"
    ? claims.chatgpt_account_id
    : undefined;
}

// --- device code -------------------------------------------------------------

async function requestUserCode(
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<{ deviceAuthId: string; userCode: string; interval: number }> {
  const response = await fetchImpl(
    `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
      signal: requestSignal(signal),
    },
  );
  const text = await response.text();
  if (response.status === 404) {
    throw new Error(
      "device code login is not enabled for this ChatGPT account; enable " +
        "it in ChatGPT's security settings, or use the browser method",
    );
  }
  if (!response.ok) {
    throw new Error(
      `device code request failed: HTTP ${response.status}: ${truncateBody(
        text,
      )}`,
    );
  }
  const data = parseJsonObject(text, "device code response");
  return {
    deviceAuthId: stringField(data, "device_auth_id"),
    userCode: stringField(data, "user_code"),
    interval: positiveNumber(data.interval, "device code interval"),
  };
}

async function pollForApproval(
  fetchImpl: FetchLike,
  deviceAuthId: string,
  userCode: string,
  intervalSeconds: number,
  signal: AbortSignal,
): Promise<{ code: string; verifier: string }> {
  const deadline = Date.now() + CHATGPT_FLOW_TIMEOUT_MS;
  for (;;) {
    const response = await fetchImpl(
      `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }),
        signal: requestSignal(signal),
      },
    );
    if (response.ok) {
      const data = parseJsonObject(
        await response.text(),
        "device token response",
      );
      return {
        code: stringField(data, "authorization_code"),
        verifier: stringField(data, "code_verifier"),
      };
    }
    // 403/404 are the current "not approved yet" answers; older builds
    // answered 409. All three mean the same thing here.
    if (
      response.status === 403 ||
      response.status === 404 ||
      response.status === 409
    ) {
      await response.body?.cancel();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("device authorization timed out");
      }
      await sleep(Math.min(intervalSeconds * 1000, remaining), signal);
      continue;
    }
    const text = await response.text();
    throw new Error(
      `device authorization failed: HTTP ${response.status}: ${truncateBody(
        text,
      )}`,
    );
  }
}

// --- browser flow ------------------------------------------------------------

interface CallbackServer {
  redirectUri: string;
  /** Resolves with the authorization code once the browser lands back. */
  waitForCode(signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

type CallbackOutcome = { code?: string; error?: Error };

/** Start a loopback listener for the callback. Both ports in the client
 * registration are tried; a machine where both are taken must use the
 * device code. The listener is bound to 127.0.0.1: the browser's callback
 * never leaves the machine. */
function startCallbackServer(state: string): CallbackServer {
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let port: number | undefined;
  let settle: (outcome: CallbackOutcome) => void = () => {};
  const received = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve;
  });

  const handler = (request: Request): Response => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      return page(404, "見つかりません", "Not found");
    }
    // A stray request (a probe, a prefetch) must not end the flow: it gets
    // the error page and the listener keeps waiting.
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
          `browser sign-in failed: ${error}${
            description === "" ? "" : ` (${description})`
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
        "The authentication code is missing.",
      );
    }
    settle({ code });
    return page(
      200,
      "ログインが完了しました",
      "Sign-in complete. You can close this tab and return to Lumisca.",
    );
  };

  for (const candidate of BROWSER_PORTS) {
    try {
      server = Deno.serve({ hostname: "127.0.0.1", port: candidate }, handler);
      port = candidate;
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.AddrInUse)) throw error;
    }
  }
  if (server === undefined || port === undefined) {
    throw new Error(
      `cannot listen for the browser callback on 127.0.0.1:${BROWSER_PORTS.join(
        " or ",
      )}; use the device code method`,
    );
  }

  let closed = false;
  return {
    redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
    waitForCode: (signal: AbortSignal) => waitForOutcome(received, signal),
    close: async () => {
      if (closed) return;
      closed = true;
      await server.shutdown();
    },
  };
}

function waitForOutcome(
  received: Promise<CallbackOutcome>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
      else resolve(outcome.code!);
    });
  });
}

// --- token exchange ----------------------------------------------------------

async function exchangeCode(
  fetchImpl: FetchLike,
  code: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CHATGPT_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const response = await fetchImpl(`${CHATGPT_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: requestSignal(signal),
  });
  return await readTokenResponse(response);
}

async function readTokenResponse(response: Response): Promise<ChatGptTokens> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `token request failed: HTTP ${response.status}: ${truncateBody(text)}`,
    );
  }
  const data = parseJsonObject(text, "token response");
  const accessToken = stringField(data, "access_token");
  const refreshToken =
    typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const idToken = typeof data.id_token === "string" ? data.id_token : undefined;
  const expiresIn = numberOrUndefined(data.expires_in);
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
  };
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
  if (!isRecord(parsed)) throw new Error(`${what} is not a JSON object`);
  return parsed;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`the response is missing "${key}"`);
  }
  return value;
}

function positiveNumber(value: unknown, what: string): number {
  const n = numberOrUndefined(value);
  if (n === undefined || n <= 0) {
    throw new Error(`${what} is not a positive number`);
  }
  return n;
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("sign-in cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("sign-in cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A small standalone page for the callback. No scripts, no external
 * resources, nothing that could be mistaken for the app. */
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
