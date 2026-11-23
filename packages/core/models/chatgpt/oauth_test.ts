import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AuthInteraction, AuthNotice } from "../../ai/catalog.ts";

import { createInMemorySettingsRepo } from "../../settings/repo.ts";
import type { FetchLike } from "./http.ts";
import {
  buildAuthorizeUrl,
  CHATGPT_AGENT_NAME,
  CHATGPT_API_BASE,
  CHATGPT_AUTH_BASE,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  expiresAtFor,
  getOrCreateHostId,
  loginWithBrowser,
  refreshChatGptToken,
  revokeChatGptToken,
  splitScopes,
  validateIdToken,
} from "./oauth.ts";

const OIDC_URL = CHATGPT_AUTH_BASE + "/.well-known/openid-configuration";
const JWKS_URL = CHATGPT_AUTH_BASE + "/jwks";
const TOKEN_URL = CHATGPT_AUTH_BASE + "/api/accounts/oauth/token";
const REVOKE_URL = CHATGPT_AUTH_BASE + "/api/accounts/oauth/revoke";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function keyMaterial(): Promise<{
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { ...jwk, kid: "test-key", alg: "RS256", use: "sig" },
  };
}

async function signIdToken(
  privateKey: CryptoKey,
  clientId: string,
  nonce: string,
  email: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ nonce, email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(CHATGPT_AUTH_BASE)
    .setAudience(clientId)
    .setSubject("subject-1")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

function discovery(): Response {
  return json({
    issuer: CHATGPT_AUTH_BASE,
    jwks_uri: JWKS_URL,
    revocation_endpoint: REVOKE_URL,
  });
}

test("the host id is generated once and reused", () => {
  const settings = createInMemorySettingsRepo();
  const first = getOrCreateHostId(settings);
  assert(first.startsWith("urn:uuid:"));
  assertEquals(getOrCreateHostId(settings), first);

  settings.set("chatgpt_host_id", "not-a-host-id");
  const second = getOrCreateHostId(settings);
  assert(second.startsWith("urn:uuid:"));
  assert(second !== first);
});

test("the authorize URL carries the registration parameters", () => {
  const url = new URL(
    buildAuthorizeUrl({
      state: "state-1",
      nonce: "nonce-1",
      challenge: "challenge-1",
      redirectUri: "http://127.0.0.1:4321/auth/callback",
      clientId: CHATGPT_DYNAMIC_CLIENT_ID,
      hostId: "urn:uuid:host-1",
    }),
  );
  assertEquals(
    url.origin + url.pathname,
    CHATGPT_AUTH_BASE + "/api/accounts/authorize",
  );
  assertEquals(url.searchParams.get("client_id"), CHATGPT_DYNAMIC_CLIENT_ID);
  assertEquals(url.searchParams.get("agent_name_hint"), CHATGPT_AGENT_NAME);
  assertEquals(url.searchParams.get("ext_agent_host_id"), "urn:uuid:host-1");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:4321/auth/callback",
  );
  assertEquals(url.searchParams.get("scope"), CHATGPT_SCOPES.join(" "));
  assertEquals(url.searchParams.get("resource"), CHATGPT_RESOURCE);
  assertEquals(url.searchParams.get("state"), "state-1");
  assertEquals(url.searchParams.get("nonce"), "nonce-1");
  assertEquals(url.searchParams.get("code_challenge"), "challenge-1");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("id_token_hint"), null);
  assertEquals(url.searchParams.get("login_hint"), null);
});

test("reauthorization reuses the issued client id and omits the hint name", () => {
  const url = new URL(
    buildAuthorizeUrl({
      state: "state-2",
      nonce: "nonce-2",
      challenge: "challenge-2",
      redirectUri: "http://127.0.0.1:4321/auth/callback",
      clientId: "oaiapp_saved",
      hostId: "urn:uuid:host-1",
      idTokenHint: "id-token-old",
      loginHint: "user@example.com",
    }),
  );
  assertEquals(url.searchParams.get("client_id"), "oaiapp_saved");
  assertEquals(url.searchParams.get("agent_name_hint"), null);
  assertEquals(url.searchParams.get("id_token_hint"), "id-token-old");
  assertEquals(url.searchParams.get("login_hint"), "user@example.com");
  assertEquals(url.searchParams.get("ext_agent_host_id"), "urn:uuid:host-1");
});

test("the browser flow registers, validates the ID token and returns the grant", async () => {
  const { privateKey, publicJwk } = await keyMaterial();
  let nonce = "";
  let tokenForm: URLSearchParams | undefined;
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    if (url === OIDC_URL) return Promise.resolve(discovery());
    if (url === JWKS_URL) {
      return Promise.resolve(json({ keys: [publicJwk] }));
    }
    if (url === TOKEN_URL) {
      tokenForm = init?.body as URLSearchParams;
      return signIdToken(
        privateKey,
        "oaiapp_test",
        nonce,
        "user@example.com",
      ).then((idToken) =>
        json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 3600,
          scope: CHATGPT_SCOPES.join(" "),
        }),
      );
    }
    return Promise.reject(new Error("unexpected request: " + url));
  };

  const notices: AuthNotice[] = [];
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    method: "browser",
    prompt: () => Promise.reject(new Error("unexpected prompt")),
    notify: (notice) => {
      notices.push(notice);
      if (notice.type !== "auth_url" || typeof notice.url !== "string") return;
      const authUrl = new URL(notice.url);
      nonce = authUrl.searchParams.get("nonce") ?? "";
      const redirect = authUrl.searchParams.get("redirect_uri") ?? "";
      void (async () => {
        const callback = new URL(redirect);
        callback.searchParams.set("code", "code-1");
        callback.searchParams.set(
          "state",
          authUrl.searchParams.get("state") ?? "",
        );
        callback.searchParams.set("client_id", "oaiapp_test");
        callback.searchParams.set("scope", CHATGPT_SCOPES.join(" "));
        const response = await fetch(callback);
        await response.text();
      })().catch(() => {
        // The flow may close the listener before the page is read.
      });
    },
  };

  const result = await loginWithBrowser(interaction, {
    fetch: fetchImpl,
    hostId: "urn:uuid:host-1",
  });

  const authUrl = new URL(String(notices[0]?.url));
  assertEquals(
    authUrl.searchParams.get("client_id"),
    CHATGPT_DYNAMIC_CLIENT_ID,
  );
  assertEquals(authUrl.searchParams.get("agent_name_hint"), CHATGPT_AGENT_NAME);
  assertEquals(
    authUrl.searchParams.get("ext_agent_host_id"),
    "urn:uuid:host-1",
  );
  assertEquals(authUrl.searchParams.get("nonce"), nonce);
  assertEquals(result.clientId, "oaiapp_test");
  assertEquals(result.hostId, "urn:uuid:host-1");
  assertEquals(result.newRegistration, true);
  assertEquals(result.identity, {
    subject: "subject-1",
    email: "user@example.com",
  });
  assertEquals(result.scopes, CHATGPT_SCOPES);
  assertEquals(result.tokens.accessToken, "access-1");
  assertEquals(tokenForm?.get("grant_type"), "authorization_code");
  assertEquals(tokenForm?.get("client_id"), "oaiapp_test");
  assertEquals(tokenForm?.get("code"), "code-1");
  assertEquals(tokenForm?.get("resource"), CHATGPT_RESOURCE);
  assertEquals(
    tokenForm?.get("redirect_uri"),
    authUrl.searchParams.get("redirect_uri"),
  );
  assert((tokenForm?.get("code_verifier") ?? "").length > 0);
});

test("a callback that omits the issued client id fails registration", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.reject(new Error("unexpected request"));
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    method: "browser",
    prompt: () => Promise.reject(new Error("unexpected prompt")),
    notify: (notice) => {
      if (notice.type !== "auth_url" || typeof notice.url !== "string") return;
      const authUrl = new URL(notice.url);
      const redirect = authUrl.searchParams.get("redirect_uri") ?? "";
      void (async () => {
        const callback = new URL(redirect);
        callback.searchParams.set("code", "code-1");
        callback.searchParams.set(
          "state",
          authUrl.searchParams.get("state") ?? "",
        );
        const response = await fetch(callback);
        await response.text();
      })().catch(() => {
        // The flow already rejected and closed the listener; this request
        // has no answer to wait for.
      });
    },
  };
  const error = await assertRejects(
    () =>
      loginWithBrowser(interaction, {
        fetch: fetchImpl,
        hostId: "urn:uuid:host-1",
      }),
    Error,
  );
  assert(error.message.includes("client_id"));
});

test("a validated ID token rejects a different nonce", async () => {
  const { privateKey, publicJwk } = await keyMaterial();
  const fetchImpl: FetchLike = (input) => {
    const url = String(input);
    if (url === OIDC_URL) return Promise.resolve(discovery());
    if (url === JWKS_URL) {
      return Promise.resolve(json({ keys: [publicJwk] }));
    }
    return Promise.reject(new Error("unexpected request: " + url));
  };
  const idToken = await signIdToken(
    privateKey,
    "oaiapp_test",
    "other-nonce",
    "user@example.com",
  );
  const error = await assertRejects(
    () =>
      validateIdToken({
        idToken,
        clientId: "oaiapp_test",
        nonce: "nonce-1",
        fetch: fetchImpl,
      }),
    Error,
  );
  assert(error.message.includes("nonce"));
});

test("refresh sends the issued client id and the resource", async () => {
  let form: URLSearchParams | undefined;
  const fetchImpl: FetchLike = (_input, init) => {
    form = init?.body as URLSearchParams;
    return Promise.resolve(
      json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 60,
      }),
    );
  };
  const tokens = await refreshChatGptToken(fetchImpl, {
    clientId: "oaiapp_test",
    refreshToken: "refresh-1",
  });
  assertEquals(form?.get("grant_type"), "refresh_token");
  assertEquals(form?.get("client_id"), "oaiapp_test");
  assertEquals(form?.get("refresh_token"), "refresh-1");
  assertEquals(form?.get("resource"), CHATGPT_RESOURCE);
  assertEquals(tokens.refreshToken, "refresh-2");
  assertEquals(tokens.expiresIn, 60);
});

test("revocation posts the refresh token to the discovered endpoint", async () => {
  let form: URLSearchParams | undefined;
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    if (url === OIDC_URL) return Promise.resolve(discovery());
    if (url === REVOKE_URL) {
      form = init?.body as URLSearchParams;
      return Promise.resolve(new Response("", { status: 200 }));
    }
    return Promise.reject(new Error("unexpected request: " + url));
  };
  await revokeChatGptToken(fetchImpl, {
    clientId: "oaiapp_test",
    refreshToken: "refresh-1",
  });
  assertEquals(form?.get("token"), "refresh-1");
  assertEquals(form?.get("token_type_hint"), "refresh_token");
  assertEquals(form?.get("client_id"), "oaiapp_test");
});

test("expiresAtFor and splitScopes read the token response", () => {
  assertEquals(expiresAtFor({ accessToken: "x", expiresIn: 60 }, 1000), 61_000);
  assertEquals(splitScopes("openid  profile "), ["openid", "profile"]);
  assertEquals(splitScopes(undefined), []);
  assertEquals(CHATGPT_API_BASE, "https://api.openai.com/v1");
});
