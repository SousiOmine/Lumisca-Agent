// Runtime guard for the ChatGPT (OpenAI Codex) login. Lumisca runs on Deno,
// where the SDK's browser-callback OAuth is Node-only — the device-code
// flow must work here. OpenAI's endpoints are stubbed, so the test proves
// the Deno path (no node:crypto/node:http, auto-selected device method)
// without touching the network.
import { assert, assertEquals } from "@std/assert";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AuthInteraction,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { autoAnswerSelect } from "@lumisca/core";

function makeAccessToken(accountId: string): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${
    b64({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })
  }.sig`;
}

Deno.test("openai-codex device-code login runs on Deno and persists oauth", async () => {
  const originalFetch = globalThis.fetch;
  let deviceAuthPolls = 0;
  let tokenExchanges = 0;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return new Response(
        JSON.stringify({
          device_auth_id: "dev_123",
          user_code: "ABCD-EFGH",
          interval: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      deviceAuthPolls += 1;
      if (deviceAuthPolls < 3) {
        return new Response(
          JSON.stringify({
            error: { code: "deviceauth_authorization_pending" },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          authorization_code: "auth_code_1",
          code_verifier: "v",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/oauth/token")) {
      tokenExchanges += 1;
      return new Response(
        JSON.stringify({
          access_token: makeAccessToken("acct_123"),
          refresh_token: "refresh_123",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return await originalFetch(input, init);
  }) as typeof fetch;

  try {
    const stored = new Map<string, unknown>();
    const credentials: CredentialStore = {
      read: (id) => Promise.resolve(stored.get(id) as Credential | undefined),
      list: () =>
        Promise.resolve(
          [...stored.keys()].map((providerId): CredentialInfo => ({
            providerId,
            type: "oauth",
          })),
        ),
      modify: async (id, fn) => {
        const next = await fn(stored.get(id) as Credential | undefined);
        if (next === undefined) stored.delete(id);
        else stored.set(id, next);
        return next;
      },
      delete: (id) => Promise.resolve(void stored.delete(id)),
    };
    const models = builtinModels({
      credentials,
      modelsStore: {
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
    });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const interaction: AuthInteraction = {
      prompt: (prompt) => {
        if (prompt.type === "select") {
          const auto = autoAnswerSelect(prompt.options);
          if (auto !== undefined) return Promise.resolve(auto);
        }
        throw new Error(`unexpected forwarded prompt: ${prompt.type}`);
      },
      notify: (event) => events.push({ ...event }),
    };

    const credential = await models.login("openai-codex", "oauth", interaction);
    const deviceEvent = events.find((e) => e.type === "device_code") as
      | { userCode: string; verificationUri: string }
      | undefined;
    assert(deviceEvent, "a device_code event must be emitted");
    assertEquals(deviceEvent.userCode, "ABCD-EFGH");
    assert(
      deviceEvent.verificationUri.includes("auth.openai.com"),
      "verification URI should point at OpenAI",
    );
    assertEquals(credential.type, "oauth");
    assertEquals(
      (credential as { accountId?: string }).accountId,
      "acct_123",
    );
    assertEquals(deviceAuthPolls, 3, "device auth should be polled");
    assertEquals(tokenExchanges, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
