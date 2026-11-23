// Credential-store tests: the API-key path, and the ChatGPT subscription
// login end to end (dynamic registration, ID-token validation, model
// catalog, revocation) with the OpenAI endpoints stubbed and a real
// loopback callback, so nothing here touches the network.

import { test } from "bun:test";
import { type AuthInteraction, forTestingCore } from "@lumisca/core";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const AUTH_BASE = "https://auth.openai.com";
const OIDC_URL = AUTH_BASE + "/.well-known/openid-configuration";
const JWKS_URL = AUTH_BASE + "/jwks";
const TOKEN_URL = AUTH_BASE + "/api/accounts/oauth/token";
const REVOKE_URL = AUTH_BASE + "/api/accounts/oauth/revoke";
const MODELS_URL = "https://api.openai.com/v1/models";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

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
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ nonce, email: "user@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(AUTH_BASE)
    .setAudience(clientId)
    .setSubject("subject-1")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

/** Start a login and answer its loopback callback once the authorize URL
 * arrives. */
function browserInteraction(onUrl: (url: URL) => void): AuthInteraction {
  return {
    signal: new AbortController().signal,
    method: "browser",
    prompt: () => Promise.reject(new Error("unexpected prompt")),
    notify: (notice) => {
      if (notice.type !== "auth_url" || typeof notice.url !== "string") return;
      const url = new URL(notice.url);
      onUrl(url);
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      setTimeout(() => {
        const callback = new URL(redirect);
        callback.searchParams.set("code", "code-1");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("client_id", "oaiapp_test");
        callback.searchParams.set("scope", SCOPES);
        void globalThis
          .fetch(callback)
          .then((response) => response.text())
          .catch(() => {});
      }, 0);
    },
  };
}

test("stored API keys drive the configured-auth check", async () => {
  const core = forTestingCore();
  try {
    assertEquals(await core.services.models.hasConfiguredAuth("openai"), false);
    assertEquals(await core.services.models.hasProviderAuth("openai"), false);

    await core.services.models.setProviderApiKey("openai", "sk-test");
    assertEquals(await core.services.models.hasConfiguredAuth("openai"), true);
    assertEquals(await core.services.models.hasProviderAuth("openai"), true);
    assertEquals(
      (await core.services.models.checkAuth("openai"))?.type,
      "api_key",
    );

    await core.services.models.logoutProvider("openai");
    assertEquals(await core.services.models.hasConfiguredAuth("openai"), false);
  } finally {
    core.close();
  }
});

test("ChatGPT login stores the registration and its models", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey, publicJwk } = await keyMaterial();
  let nonce = "";
  const modelsStatus = 200;
  const requested: string[] = [];

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    if (url === OIDC_URL) {
      return Promise.resolve(
        json({
          issuer: AUTH_BASE,
          jwks_uri: JWKS_URL,
          revocation_endpoint: REVOKE_URL,
        }),
      );
    }
    if (url === JWKS_URL) {
      return Promise.resolve(json({ keys: [publicJwk] }));
    }
    if (url === TOKEN_URL) {
      return signIdToken(privateKey, "oaiapp_test", nonce).then((idToken) =>
        json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 3600,
          scope: SCOPES,
        }),
      );
    }
    if (url === MODELS_URL) {
      if (modelsStatus !== 200) {
        return Promise.resolve(
          new Response("upstream down", {
            status: modelsStatus,
          }),
        );
      }
      return Promise.resolve(
        json({
          models: [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1 Sol",
              visibility: "list",
              context_window: 400_000,
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "high" },
              ],
            },
          ],
        }),
      );
    }
    if (url === REVOKE_URL) {
      return Promise.resolve(new Response("", { status: 200 }));
    }
    return Promise.reject(new Error("unexpected request: " + url));
  }) as typeof fetch;

  const core = forTestingCore();
  try {
    await core.services.models.loginProvider(
      "openai-codex",
      "oauth",
      browserInteraction((url) => {
        nonce = url.searchParams.get("nonce") ?? "";
      }),
    );

    assertEquals(
      await core.services.models.getProviderAuthType("openai-codex"),
      "oauth",
    );
    const check = await core.services.models.checkAuth("openai-codex");
    assertEquals(check?.type, "oauth");
    assertEquals(check?.account, "user@example.com");
    assertEquals(
      await core.services.models.hasConfiguredAuth("openai-codex"),
      true,
    );
    assertEquals(
      core.services.models
        .listModelsDetailed("openai-codex")
        .map((model) => model.id),
      ["gpt-6.1-sol"],
    );
    assert(requested.includes(MODELS_URL));

    // The credential is a normal stored credential: logout revokes it and
    // removes the local record.
    assertEquals(
      await core.services.models.logoutProvider("openai-codex"),
      undefined,
    );
    assertEquals(
      await core.services.models.hasConfiguredAuth("openai-codex"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    core.close();
  }
});

test("a failed model catalog leaves the provider unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey, publicJwk } = await keyMaterial();
  let nonce = "";

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    if (url === OIDC_URL) {
      return Promise.resolve(
        json({
          issuer: AUTH_BASE,
          jwks_uri: JWKS_URL,
          revocation_endpoint: REVOKE_URL,
        }),
      );
    }
    if (url === JWKS_URL) {
      return Promise.resolve(json({ keys: [publicJwk] }));
    }
    if (url === TOKEN_URL) {
      return signIdToken(privateKey, "oaiapp_test", nonce).then((idToken) =>
        json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 3600,
          scope: SCOPES,
        }),
      );
    }
    if (url === MODELS_URL) {
      return Promise.resolve(new Response("upstream down", { status: 503 }));
    }
    return Promise.reject(new Error("unexpected request: " + url));
  }) as typeof fetch;

  const core = forTestingCore();
  try {
    await assertRejects(
      () =>
        core.services.models.loginProvider(
          "openai-codex",
          "oauth",
          browserInteraction((url) => {
            nonce = url.searchParams.get("nonce") ?? "";
          }),
        ),
      Error,
      "HTTP 503",
    );
    // The credential is persisted only after the catalog succeeds.
    assertEquals(
      await core.services.models.hasConfiguredAuth("openai-codex"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    core.close();
  }
});
