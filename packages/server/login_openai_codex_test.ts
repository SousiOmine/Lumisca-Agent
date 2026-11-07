// Credential-store tests: the API-key path, and the ChatGPT subscription
// login end to end (device code, token exchange, model catalog) with the
// OpenAI endpoints stubbed, so nothing here touches the network.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type AuthInteraction, LumiscaCore } from "@lumisca/core";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(claims)}.signature`;
}

Deno.test("stored API keys drive the configured-auth check", async () => {
  const core = LumiscaCore.forTesting();
  try {
    // A built-in provider with no stored key and a cleaned env is not
    // configured in Lumisca.
    assertEquals(await core.hasConfiguredAuth("openai"), false);
    assertEquals(await core.hasProviderAuth("openai"), false);

    // Storing a key makes it configured (the key-injection path).
    await core.setProviderApiKey("openai", "sk-test");
    assertEquals(await core.hasConfiguredAuth("openai"), true);
    assertEquals(await core.hasProviderAuth("openai"), true);
    assertEquals((await core.checkAuth("openai"))?.type, "api_key");

    // Logging out clears the configured state again.
    await core.logoutProvider("openai");
    assertEquals(await core.hasConfiguredAuth("openai"), false);
  } finally {
    core.close();
  }
});

Deno.test("ChatGPT device login stores an OAuth credential and its models", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      return json({
        device_auth_id: "dev_1",
        user_code: "ABCD-EFGH",
        interval: 0.001,
      });
    }
    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
      return json({
        authorization_code: "code_1",
        code_verifier: "verifier_1",
      });
    }
    if (url === "https://auth.openai.com/oauth/token") {
      return json({
        access_token: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh_token: "refresh_1",
        expires_in: 3600,
      });
    }
    if (url.startsWith("https://chatgpt.com/backend-api/codex/models")) {
      return json({
        models: [{
          slug: "gpt-5.3-codex",
          display_name: "GPT-5.3 Codex",
          context_window: 400_000,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        }],
      });
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  }) as typeof fetch;

  const core = LumiscaCore.forTesting();
  try {
    const events: string[] = [];
    const interaction: AuthInteraction = {
      signal: new AbortController().signal,
      method: "device_code",
      prompt: () => Promise.reject(new Error("unexpected prompt")),
      notify: (event) => events.push(event.type),
    };

    await core.loginProvider("openai-codex", "oauth", interaction);

    assertEquals(events, ["device_code"]);
    assertEquals(await core.getProviderAuthType("openai-codex"), "oauth");
    assertEquals((await core.checkAuth("openai-codex"))?.type, "oauth");
    assertEquals(await core.hasConfiguredAuth("openai-codex"), true);
    assertEquals(
      core.listModelsDetailed("openai-codex").map((model) => model.id),
      ["gpt-5.3-codex"],
    );
    assert(
      requested.some((url) => url.includes("/codex/models?client_version=")),
      "the model catalog must be fetched during the login",
    );

    // The credential is a normal stored credential: logout removes it.
    await core.logoutProvider("openai-codex");
    assertEquals(await core.hasConfiguredAuth("openai-codex"), false);
  } finally {
    globalThis.fetch = originalFetch;
    core.close();
  }
});

Deno.test("a failed model catalog leaves the provider unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      return json({
        device_auth_id: "dev_1",
        user_code: "ABCD-EFGH",
        interval: 0.001,
      });
    }
    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
      return json({
        authorization_code: "code_1",
        code_verifier: "verifier_1",
      });
    }
    if (url === "https://auth.openai.com/oauth/token") {
      return json({
        access_token: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh_token: "refresh_1",
        expires_in: 3600,
      });
    }
    if (url.startsWith("https://chatgpt.com/backend-api/codex/models")) {
      return new Response("upstream down", { status: 503 });
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  }) as typeof fetch;

  const core = LumiscaCore.forTesting();
  try {
    const interaction: AuthInteraction = {
      signal: new AbortController().signal,
      method: "device_code",
      prompt: () => Promise.reject(new Error("unexpected prompt")),
      notify: () => {},
    };
    await assertRejects(
      () => core.loginProvider("openai-codex", "oauth", interaction),
      Error,
      "HTTP 503",
    );
    // The credential is persisted only after the catalog succeeds.
    assertEquals(await core.hasConfiguredAuth("openai-codex"), false);
  } finally {
    globalThis.fetch = originalFetch;
    core.close();
  }
});
