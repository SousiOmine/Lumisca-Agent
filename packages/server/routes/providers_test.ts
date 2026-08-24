import { assert, assertEquals } from "@std/assert";
import type {
  AuthInteraction,
  AuthType,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  AuthCheck,
  ModelInfo,
  ProviderAuthType,
  ProviderLoginSnapshot,
} from "@lumisca/core";
import { type ProviderApi, providerRoutes } from "./providers.ts";
import { jsonError } from "./util.ts";

/** Deterministic stand-in for the core: the login script drives the
 * interaction and "persists" a credential on success, mirroring what the
 * real core does after `models.login`. */
class FakeProviderApi implements ProviderApi {
  oauthProviders = new Set(["openai-codex"]);
  loggedIn = new Set<string>();
  /** Providers whose auth resolves through an ambient env var (the SDK
   * resolves them, but they are not stored in Lumisca). */
  envAuth = new Set<string>();
  logoutCalls: string[] = [];
  loginScript: ((interaction: AuthInteraction) => Promise<void>) | undefined;

  listProviders(): readonly Provider[] {
    return [...this.oauthProviders, "anthropic"].map((id) =>
      ({ id, name: id }) as Provider
    );
  }
  listModelsDetailed(): ModelInfo[] {
    return [];
  }
  setModelEnabled(): void {}
  setModelThinkingLevel(): string {
    return "off";
  }
  checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    if (this.loggedIn.has(providerId)) {
      return Promise.resolve({ type: "oauth" as const, source: "OAuth" });
    }
    if (this.envAuth.has(providerId)) {
      return Promise.resolve({
        type: "api_key" as const,
        source: "ANTHROPIC_API_KEY",
      });
    }
    return Promise.resolve(undefined);
  }
  hasConfiguredAuth(providerId: string): Promise<boolean> {
    return Promise.resolve(this.loggedIn.has(providerId));
  }
  setProviderApiKey(): Promise<void> {
    return Promise.resolve();
  }
  getProviderAuthType(providerId: string): ProviderAuthType | undefined {
    return this.oauthProviders.has(providerId) ? "oauth" : "api_key";
  }
  async loginProvider(
    providerId: string,
    _type: AuthType,
    interaction: AuthInteraction,
  ): Promise<void> {
    if (!this.loginScript) throw new Error("no login script set");
    await this.loginScript(interaction);
    this.loggedIn.add(providerId);
  }
  logoutProvider(providerId: string): Promise<void> {
    this.logoutCalls.push(providerId);
    this.loggedIn.delete(providerId);
    return Promise.resolve();
  }
}

function makeApp(fake: FakeProviderApi) {
  const app = providerRoutes(fake);
  app.onError((error, c) => jsonError(c, error));
  return app;
}

async function snapshot(
  app: ReturnType<typeof providerRoutes>,
  sessionId: string,
): Promise<ProviderLoginSnapshot> {
  const res = await app.request(
    `/providers/openai-codex/login/${sessionId}`,
  );
  assertEquals(res.status, 200);
  return await res.json();
}

async function pollUntil(
  app: ReturnType<typeof providerRoutes>,
  sessionId: string,
  status: string,
  timeoutMs = 2000,
): Promise<ProviderLoginSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snap: ProviderLoginSnapshot;
  do {
    snap = await snapshot(app, sessionId);
    if (snap.status === status) return snap;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for login ${status}, got ${snap.status}`);
}

Deno.test("/providers exposes authType per provider", async () => {
  const app = makeApp(new FakeProviderApi());
  const res = await app.request("/providers");
  assertEquals(res.status, 200);
  const list = await res.json();
  assertEquals(list, [
    {
      id: "openai-codex",
      name: "openai-codex",
      configured: false,
      authType: "oauth",
    },
    {
      id: "anthropic",
      name: "anthropic",
      configured: false,
      authType: "api_key",
    },
  ]);
});

Deno.test("ambient env auth does not mark a provider as configured", async () => {
  const fake = new FakeProviderApi();
  // ANTHROPIC_API_KEY is set in the environment: the SDK resolves auth,
  // but the user never stored anything in Lumisca.
  fake.envAuth.add("anthropic");
  const app = makeApp(fake);

  const res = await app.request("/providers");
  assertEquals(res.status, 200);
  const list = await res.json();
  assertEquals(
    list.find((p: { id: string }) => p.id === "anthropic"),
    {
      id: "anthropic",
      name: "anthropic",
      configured: false,
      source: "ANTHROPIC_API_KEY",
      authType: "api_key",
    },
  );
  // The per-provider auth endpoint agrees.
  const auth = await (await app.request("/providers/anthropic/auth")).json();
  assertEquals(auth.configured, false);
  assertEquals(auth.source, "ANTHROPIC_API_KEY");
});

Deno.test("OAuth login runs a device-code flow and marks the provider configured", async () => {
  const fake = new FakeProviderApi();
  fake.loginScript = async (interaction) => {
    const method = await interaction.prompt({
      type: "select",
      message: "Select login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
    assertEquals(method, "device_code", "device method must be auto-selected");
    interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    });
  };
  const app = makeApp(fake);
  // Prime the auth cache (unconfigured).
  await app.request("/providers");

  const start = await app.request("/providers/openai-codex/login", {
    method: "POST",
  });
  assertEquals(start.status, 200);
  const { sessionId } = await start.json();

  const snap = await pollUntil(app, sessionId, "done");
  assertEquals(snap.events, [{
    type: "device_code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://auth.openai.com/codex/device",
  }]);
  assertEquals(snap.prompt, undefined);
  assert(fake.loggedIn.has("openai-codex"));

  // The auth cache was invalidated on completion: the provider now lists
  // as configured and oauth.
  const list = await (await app.request("/providers")).json();
  assertEquals(
    list.find((p: { id: string }) => p.id === "openai-codex").configured,
    true,
  );
});

Deno.test("login is refused for non-OAuth providers and unknown ids", async () => {
  const app = makeApp(new FakeProviderApi());
  const nonOAuth = await app.request("/providers/anthropic/login", {
    method: "POST",
  });
  assertEquals(nonOAuth.status, 400);
  const unknown = await app.request("/providers/nope/login", {
    method: "POST",
  });
  assertEquals(unknown.status, 404);
});

Deno.test("a forwarded prompt resolves through POST respond", async () => {
  const fake = new FakeProviderApi();
  fake.loginScript = async (interaction) => {
    const picked = await interaction.prompt({
      type: "select",
      message: "Pick one:",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    });
    interaction.notify({ type: "progress", message: `chose ${picked}` });
  };
  const app = makeApp(fake);
  const { sessionId } = await (await app.request(
    "/providers/openai-codex/login",
    { method: "POST" },
  )).json();

  let snap: ProviderLoginSnapshot;
  const deadline = Date.now() + 2000;
  do {
    snap = await snapshot(app, sessionId);
    if (snap.prompt !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert(snap.prompt, "expected a forwarded prompt");
  const promptId = snap.prompt.id;

  const respond = await app.request(
    `/providers/openai-codex/login/${sessionId}/respond`,
    {
      method: "POST",
      body: JSON.stringify({ promptId, value: "b" }),
    },
  );
  assertEquals(respond.status, 200);

  const done = await pollUntil(app, sessionId, "done");
  assertEquals(done.events, [{ type: "progress", message: "chose b" }]);
});

Deno.test("cancelling a login leaves the provider unconfigured", async () => {
  const fake = new FakeProviderApi();
  fake.loginScript = async (interaction) => {
    await interaction.prompt({ type: "manual_code", message: "paste code" });
  };
  const app = makeApp(fake);
  const { sessionId } = await (await app.request(
    "/providers/openai-codex/login",
    { method: "POST" },
  )).json();

  let snap: ProviderLoginSnapshot;
  const deadline = Date.now() + 2000;
  do {
    snap = await snapshot(app, sessionId);
    if (snap.prompt !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assertEquals(snap.prompt?.type, "manual_code");

  const cancel = await app.request(
    `/providers/openai-codex/login/${sessionId}/cancel`,
    { method: "POST" },
  );
  assertEquals(cancel.status, 200);
  await pollUntil(app, sessionId, "cancelled");
  assert(!fake.loggedIn.has("openai-codex"));
});

Deno.test("a second login request reuses the running session", async () => {
  const fake = new FakeProviderApi();
  let started = 0;
  fake.loginScript = async (interaction) => {
    started += 1;
    await interaction.prompt({ type: "manual_code", message: "paste code" });
  };
  const app = makeApp(fake);
  const first = await (await app.request(
    "/providers/openai-codex/login",
    { method: "POST" },
  )).json();
  const second = await (await app.request(
    "/providers/openai-codex/login",
    { method: "POST" },
  )).json();
  assertEquals((second as { sessionId: string }).sessionId, first.sessionId);
  assertEquals(started, 1);
  // Clean up so no dangling session keeps polling.
  await app.request(
    `/providers/openai-codex/login/${first.sessionId}/cancel`,
    { method: "POST" },
  );
});

Deno.test("a failing login surfaces as error without configuring the provider", async () => {
  const fake = new FakeProviderApi();
  fake.loginScript = () => {
    throw new Error("token exchange failed");
  };
  const app = makeApp(fake);
  const { sessionId } = await (await app.request(
    "/providers/openai-codex/login",
    { method: "POST" },
  )).json();
  const snap = await pollUntil(app, sessionId, "error");
  assertEquals(snap.error, "token exchange failed");
  assert(!fake.loggedIn.has("openai-codex"));
});

Deno.test("logout removes the credential and invalidates the auth cache", async () => {
  const fake = new FakeProviderApi();
  fake.loggedIn.add("openai-codex");
  const app = makeApp(fake);
  await app.request("/providers"); // cache: configured = true

  const res = await app.request("/providers/openai-codex/logout", {
    method: "POST",
  });
  assertEquals(res.status, 200);
  assert(fake.logoutCalls.includes("openai-codex"));

  const list = await (await app.request("/providers")).json();
  assertEquals(
    list.find((p: { id: string }) => p.id === "openai-codex").configured,
    false,
  );
});
