import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  OAuthCredential,
} from "../../ai/catalog.ts";

import { createInMemorySettingsRepo } from "../../settings/repo.ts";
import { CHATGPT_PROVIDER_ID, saveChatGptModels } from "./catalog.ts";
import type { FetchLike } from "./http.ts";
import {
  CHATGPT_API_BASE,
  CHATGPT_AUTH_BASE,
  CHATGPT_SCOPES,
  type ChatGptLoginResult,
} from "./oauth.ts";
import { chatgptProvider } from "./provider.ts";

const OIDC_URL = CHATGPT_AUTH_BASE + "/.well-known/openid-configuration";
const JWKS_URL = CHATGPT_AUTH_BASE + "/jwks";
const REVOKE_URL = CHATGPT_AUTH_BASE + "/api/accounts/oauth/revoke";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A credential store with one provider's credential in memory. */
function memoryStore(initial?: Credential): {
  store: CredentialStore;
  current: () => Credential | undefined;
} {
  let stored = initial;
  return {
    store: {
      read: () => Promise.resolve(stored),
      list: () =>
        Promise.resolve(
          stored === undefined
            ? []
            : [{ providerId: CHATGPT_PROVIDER_ID, type: stored.type }],
        ),
      modify: (_providerId, fn) =>
        fn(stored).then((next) => {
          stored = next;
          return next;
        }),
      delete: () => {
        stored = undefined;
        return Promise.resolve();
      },
    },
    current: () => stored,
  };
}

function noNetwork(): FetchLike {
  return () => Promise.reject(new Error("unexpected network request"));
}

function loggedInCredential(
  overrides: Partial<OAuthCredential> = {},
): OAuthCredential {
  return {
    type: "oauth",
    token: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3600_000,
    clientId: "oaiapp_test",
    hostId: "urn:uuid:host-1",
    idToken: "id-token-old",
    subject: "subject-1",
    email: "user@example.com",
    scopes: CHATGPT_SCOPES,
    ...overrides,
  };
}

const loginResult: ChatGptLoginResult = {
  tokens: {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    idToken: "id-token",
    expiresIn: 3600,
    scope: CHATGPT_SCOPES.join(" "),
  },
  clientId: "oaiapp_test",
  hostId: "urn:uuid:host-1",
  scopes: CHATGPT_SCOPES,
  identity: { subject: "subject-1", email: "user@example.com" },
  idToken: "id-token",
  newRegistration: true,
};

const browserInteraction: AuthInteraction = {
  signal: new AbortController().signal,
  method: "browser",
  prompt: () => Promise.reject(new Error("unexpected prompt")),
  notify: () => {},
};

test("resolveCredential returns the access token without headers", async () => {
  const credential = loggedInCredential();
  const credentials = memoryStore(credential);
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });

  const resolved = await provider.resolveCredential({ credential, env: {} });

  assertEquals(resolved?.auth.apiKey, "access-1");
  assertEquals(resolved?.source, "OAuth");
  assertEquals(resolved?.headers, undefined);
});

test("a credential from the old flow is refused with a re-login message", async () => {
  const credential = loggedInCredential();
  delete credential.clientId;
  const credentials = memoryStore(credential);
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });

  const error = await assertRejects(
    () => provider.resolveCredential({ credential, env: {} }),
    Error,
  );
  assert(error.message.includes("古い方式"));
});

test("an expiring credential is refreshed once for concurrent callers", async () => {
  let refreshes = 0;
  let form: URLSearchParams | undefined;
  const fetchImpl: FetchLike = (_input, init) => {
    refreshes += 1;
    form = init?.body as URLSearchParams;
    return Promise.resolve(
      json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: CHATGPT_SCOPES.join(" "),
      }),
    );
  };
  const expired = loggedInCredential({
    token: "access-old",
    expiresAt: Date.now() - 1000,
  });
  const credentials = memoryStore(expired);
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings: createInMemorySettingsRepo(),
    fetch: fetchImpl,
  });

  const [first, second] = await Promise.all([
    provider.resolveCredential({ credential: expired, env: {} }),
    provider.resolveCredential({ credential: expired, env: {} }),
  ]);

  assertEquals(refreshes, 1, "the refresh must not run twice");
  assertEquals(first?.auth.apiKey, "access-2");
  assertEquals(second?.auth.apiKey, "access-2");
  assertEquals(form?.get("grant_type"), "refresh_token");
  assertEquals(form?.get("client_id"), "oaiapp_test");
  const stored = credentials.current() as OAuthCredential;
  assertEquals(stored.refreshToken, "refresh-2");
  assertEquals(stored.token, "access-2");
  assertEquals(stored.clientId, "oaiapp_test");
});

test("an expired credential without a refresh token fails fast", async () => {
  const expired = loggedInCredential({
    expiresAt: Date.now() - 1000,
    refreshToken: undefined,
  });
  const credentials = memoryStore(expired);
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });

  await assertRejects(
    () => provider.resolveCredential({ credential: expired, env: {} }),
    Error,
    "expired",
  );
});

test("an api-key credential does not resolve for this provider", async () => {
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });
  assertEquals(
    await provider.resolveCredential({
      credential: { type: "api_key", key: "sk-test" },
      env: {},
    }),
    undefined,
  );
  assertEquals(await provider.resolveCredential({ env: {} }), undefined);
});

test("login without a method fails fast", async () => {
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    prompt: () => Promise.reject(new Error("unexpected prompt")),
    notify: () => {},
  };
  await assertRejects(
    () => provider.auth.oauth!.login(interaction),
    Error,
    "method",
  );
});

test("login stores the registration and fetches the account models", async () => {
  let modelRequest: string | undefined;
  const fetchImpl: FetchLike = (input) => {
    modelRequest = String(input);
    return Promise.resolve(
      json({
        models: [
          {
            slug: "gpt-6.1-sol",
            display_name: "GPT-6.1 Sol",
            visibility: "list",
          },
        ],
      }),
    );
  };
  const settings = createInMemorySettingsRepo();
  const credentials = memoryStore();
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings,
    fetch: fetchImpl,
    login: () => Promise.resolve(loginResult),
  });

  const credential = await provider.auth.oauth!.login(browserInteraction);

  assertEquals(modelRequest, CHATGPT_API_BASE + "/models");
  assertEquals(credential.type, "oauth");
  const stored = credential as OAuthCredential;
  assertEquals(stored.clientId, "oaiapp_test");
  assertEquals(stored.hostId, "urn:uuid:host-1");
  assertEquals(stored.subject, "subject-1");
  assertEquals(stored.email, "user@example.com");
  assertEquals(stored.scopes, CHATGPT_SCOPES);
  assertEquals(
    provider.getModels().map((model) => model.id),
    ["gpt-6.1-sol"],
  );
});

test("a login without the plan scope is refused", async () => {
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
    login: () =>
      Promise.resolve({
        ...loginResult,
        scopes: ["openid", "profile", "email", "offline_access"],
        tokens: { accessToken: "access-1", expiresIn: 3600 },
      }),
  });
  const error = await assertRejects(
    () => provider.auth.oauth!.login(browserInteraction),
    Error,
  );
  assert(error.message.includes("プラン"));
});

test("logout revokes the renewable session", async () => {
  let revoked: URLSearchParams | undefined;
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    if (url === OIDC_URL) {
      return Promise.resolve(
        json({
          issuer: CHATGPT_AUTH_BASE,
          jwks_uri: JWKS_URL,
          revocation_endpoint: REVOKE_URL,
        }),
      );
    }
    if (url === REVOKE_URL) {
      revoked = init?.body as URLSearchParams;
      return Promise.resolve(new Response("", { status: 200 }));
    }
    return Promise.reject(new Error("unexpected request: " + url));
  };
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings: createInMemorySettingsRepo(),
    fetch: fetchImpl,
  });
  const warning = await provider.auth.oauth!.logout!(
    loggedInCredential() as OAuthCredential,
  );
  assertEquals(warning, undefined);
  assertEquals(revoked?.get("token"), "refresh-1");
  assertEquals(revoked?.get("client_id"), "oaiapp_test");
});

test("logout reports an unconfirmed revocation", async () => {
  const fetchImpl: FetchLike = (input) => {
    const url = String(input);
    if (url === OIDC_URL) {
      return Promise.resolve(
        json({
          issuer: CHATGPT_AUTH_BASE,
          jwks_uri: JWKS_URL,
          revocation_endpoint: REVOKE_URL,
        }),
      );
    }
    if (url === REVOKE_URL) {
      return Promise.resolve(new Response("down", { status: 503 }));
    }
    return Promise.reject(new Error("unexpected request: " + url));
  };
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings: createInMemorySettingsRepo(),
    fetch: fetchImpl,
  });
  const warning = await provider.auth.oauth!.logout!(
    loggedInCredential() as OAuthCredential,
  );
  assert(warning?.includes("失効を確認できません"));
});

test("getModels serves the catalog stored at login", () => {
  const settings = createInMemorySettingsRepo();
  saveChatGptModels(settings, [
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      api: "openai-responses",
      provider: CHATGPT_PROVIDER_ID,
      baseUrl: CHATGPT_API_BASE,
    },
  ]);
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings,
    fetch: noNetwork(),
  });
  assert(provider.getModels().length === 1);
  assertEquals(provider.getModels()[0]?.id, "gpt-6.1-sol");
  assertEquals(provider.auth.oauth?.methods, ["browser"]);
});
