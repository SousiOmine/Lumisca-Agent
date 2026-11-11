import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  OAuthCredential,
} from "../../ai/types.ts";
import { createInMemorySettingsRepo } from "../../settings/repo.ts";
import { saveChatGptModels } from "./catalog.ts";
import type { FetchLike } from "./http.ts";
import { chatgptProvider } from "./provider.ts";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(claims)}.signature`;
}

function accountToken(accountId: string, exp: number): string {
  return jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    exp,
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
            : [
                {
                  providerId: "openai-codex",
                  type: stored.type,
                },
              ],
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

Deno.test("resolveCredential returns the account headers without a refresh", async () => {
  const token = accountToken("acct-1", Math.floor(Date.now() / 1000) + 3600);
  const credential: OAuthCredential = {
    type: "oauth",
    token,
    expiresAt: Date.now() + 3600_000,
    accountId: "acct-1",
    refreshToken: "refresh-1",
  };
  const credentials = memoryStore(credential);
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });

  const resolved = await provider.resolveCredential({ credential, env: {} });

  assertEquals(resolved?.auth.apiKey, token);
  assertEquals(resolved?.source, "OAuth");
  assertEquals(resolved?.headers, {
    "ChatGPT-Account-Id": "acct-1",
    originator: "lumisca",
  });
});

Deno.test("resolveCredential reads the account id from the token when absent", async () => {
  const token = accountToken(
    "acct-token",
    Math.floor(Date.now() / 1000) + 3600,
  );
  const credential: OAuthCredential = {
    type: "oauth",
    token,
    expiresAt: Date.now() + 3600_000,
  };
  const credentials = memoryStore(credential);
  const provider = chatgptProvider({
    credentials: credentials.store,
    settings: createInMemorySettingsRepo(),
    fetch: noNetwork(),
  });

  const resolved = await provider.resolveCredential({ credential, env: {} });
  assertEquals(resolved?.headers?.["ChatGPT-Account-Id"], "acct-token");
});

Deno.test("an expiring credential is refreshed once for concurrent callers", async () => {
  let refreshes = 0;
  const fetchImpl: FetchLike = () => {
    refreshes += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: accountToken(
            "acct-2",
            Math.floor(Date.now() / 1000) + 3600,
          ),
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };
  const expired: OAuthCredential = {
    type: "oauth",
    token: accountToken("acct-1", 1),
    expiresAt: Date.now() - 1000,
    accountId: "acct-1",
    refreshToken: "refresh-1",
  };
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
  assertEquals(first?.auth.apiKey, second?.auth.apiKey);
  assertEquals(first?.headers?.["ChatGPT-Account-Id"], "acct-2");
  const stored = credentials.current() as OAuthCredential;
  assertEquals(stored.refreshToken, "refresh-2");
  assertEquals(stored.accountId, "acct-2");
});

Deno.test("an expired credential without a refresh token fails fast", async () => {
  const expired: OAuthCredential = {
    type: "oauth",
    token: accountToken("acct-1", 1),
    expiresAt: Date.now() - 1000,
    accountId: "acct-1",
  };
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

Deno.test("an api-key credential does not resolve for this provider", async () => {
  const credentials = memoryStore();
  const provider = chatgptProvider({
    credentials: credentials.store,
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

Deno.test("login without a method fails fast", async () => {
  const credentials = memoryStore();
  const provider = chatgptProvider({
    credentials: credentials.store,
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

Deno.test("getModels serves the catalog stored at login", () => {
  const settings = createInMemorySettingsRepo();
  saveChatGptModels(settings, [
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
  ]);
  const provider = chatgptProvider({
    credentials: memoryStore().store,
    settings,
    fetch: noNetwork(),
  });
  assert(provider.getModels().length === 1);
  assertEquals(provider.getModels()[0]?.id, "gpt-5.3-codex");
  assertEquals(provider.auth.oauth?.methods, ["browser", "device_code"]);
});
