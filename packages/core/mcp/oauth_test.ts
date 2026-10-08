import { assert, assertEquals } from "@std/assert";
import { createInMemorySettingsRepo } from "../settings/repo.ts";
import { parseMcpConfig } from "./config.ts";
import { McpManager } from "./manager.ts";
import { McpOAuthStore } from "./oauth.ts";
import { McpService } from "./service.ts";
import { startFakeAuthServer, startFakeMcpServer } from "./fake-http.ts";

/** The callback path of a server reached at its own origin — the shape the
 * route builds (see routes/mcp.ts). */
const REDIRECT_URI = "http://127.0.0.1:8000/api/mcp/oauth/callback";

/** An McpService for the sign-in tests: no sessions, no configuration
 * surface (only the probe and the flow are exercised). */
function makeService(): McpService {
  return new McpService({
    settings: createInMemorySettingsRepo(),
    listSessions: () => [],
    agentMcpStatus: () => null,
    requireWorkspace: () => {
      throw new Error("not used");
    },
    applySessionChange: () => {},
    refreshSessionMcp: () => {},
  });
}

/** The single-server body the settings UI sends (test and sign-in alike). */
function serverBody(url: string): string {
  return JSON.stringify({ mcpServers: { probe: { url } } });
}

Deno.test("OAuth: the sign-in grants what the next connection uses", async () => {
  const auth = startFakeAuthServer();
  const mcp = startFakeMcpServer({
    token: "access-token-1",
    authorizationServerUrl: auth.url,
  });
  const service = makeService();
  const body = serverBody(mcp.url);
  try {
    // 1. Without a grant the server answers 401: the test says "sign in".
    const before = await service.testServer(body, 10_000);
    assertEquals(before.ok, false);
    assertEquals(before.needsAuth, true);

    // 2. Starting the flow walks discovery, registration and the
    //    authorization request; the snapshot carries the URL to open.
    const started = await service.startAuth(body, REDIRECT_URI);
    assertEquals(started.status, "waiting");
    assertEquals(started.serverUrl, mcp.url);
    assertEquals(auth.registrations, 1);
    const authorizationUrl = new URL(started.authorizationUrl!);
    assertEquals(
      authorizationUrl.origin + authorizationUrl.pathname,
      `${auth.url}/authorize`,
    );
    assertEquals(authorizationUrl.searchParams.get("client_id"), "test-client");
    assertEquals(
      authorizationUrl.searchParams.get("redirect_uri"),
      REDIRECT_URI,
    );
    assertEquals(
      authorizationUrl.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert(
      (authorizationUrl.searchParams.get("code_challenge") ?? "").length > 0,
    );
    // RFC 8707: the token is asked for this resource.
    assertEquals(authorizationUrl.searchParams.get("resource"), mcp.url);

    // 3. The browser comes back to the callback with the code and state.
    const state = authorizationUrl.searchParams.get("state")!;
    const done = await service.completeAuth({ state, code: "test-code" });
    assertEquals(done?.status, "done");
    assertEquals(auth.tokenRequests, 1);
    assertEquals(
      auth.lastTokenRequest?.get("grant_type"),
      "authorization_code",
    );
    assertEquals(auth.lastTokenRequest?.get("code"), "test-code");
    assert(
      (auth.lastTokenRequest?.get("code_verifier") ?? "").length > 0,
      "the PKCE verifier must ride with the code",
    );

    // 4. The probe (the settings test) now reaches the server with the
    //    token, and the poll can still see how the sign-in ended.
    const after = await service.testServer(body, 10_000);
    assertEquals(after.ok, true);
    assertEquals(after.tools.map((tool) => tool.name), ["echo"]);
    assertEquals(service.getAuth(started.sessionId)?.status, "done");
    assertEquals(
      mcp.requests.at(-1)!.headers.authorization,
      "Bearer access-token-1",
    );
  } finally {
    await mcp.close();
    await auth.close();
  }
});

Deno.test("OAuth: a callback with an unknown state is refused", async () => {
  const auth = startFakeAuthServer();
  const mcp = startFakeMcpServer({
    token: "access-token-1",
    authorizationServerUrl: auth.url,
  });
  const service = makeService();
  try {
    await service.startAuth(serverBody(mcp.url), REDIRECT_URI);
    // A forged, expired or already-finished callback: nothing to finish,
    // and nothing is exchanged with the authorization server.
    assertEquals(
      await service.completeAuth({ state: "not-a-state", code: "code" }),
      undefined,
    );
    assertEquals(auth.tokenRequests, 0);
  } finally {
    await mcp.close();
    await auth.close();
  }
});

Deno.test("OAuth: a cancelled sign-in exchanges nothing", async () => {
  const auth = startFakeAuthServer();
  const mcp = startFakeMcpServer({
    token: "access-token-1",
    authorizationServerUrl: auth.url,
  });
  const service = makeService();
  try {
    const started = await service.startAuth(serverBody(mcp.url), REDIRECT_URI);
    const authorizationUrl = new URL(started.authorizationUrl!);
    assertEquals(service.cancelAuth(started.sessionId), true);
    assertEquals(service.getAuth(started.sessionId)?.status, "cancelled");
    // The browser may still come back after the user gave up; the flow is
    // gone, so its state no longer matches anything.
    assertEquals(
      await service.completeAuth({
        state: authorizationUrl.searchParams.get("state")!,
        code: "test-code",
      }),
      undefined,
    );
    assertEquals(auth.tokenRequests, 0);
    assertEquals(service.cancelAuth(started.sessionId), true);
  } finally {
    await mcp.close();
    await auth.close();
  }
});

Deno.test("OAuth: the authorization server's refusal is reported", async () => {
  const auth = startFakeAuthServer();
  const mcp = startFakeMcpServer({
    token: "access-token-1",
    authorizationServerUrl: auth.url,
  });
  const service = makeService();
  try {
    const started = await service.startAuth(serverBody(mcp.url), REDIRECT_URI);
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    const failed = await service.completeAuth({
      state,
      error: "access_denied",
    });
    assertEquals(failed?.status, "error");
    assert(failed?.error?.includes("access_denied") ?? false);
    // No grant was stored, so the next test still asks for a sign-in.
    const retest = await service.testServer(serverBody(mcp.url), 10_000);
    assertEquals(retest.needsAuth, true);
  } finally {
    await mcp.close();
    await auth.close();
  }
});

Deno.test("OAuth: a session's connections use the stored grant", async () => {
  const auth = startFakeAuthServer();
  const mcp = startFakeMcpServer({
    token: "access-token-1",
    authorizationServerUrl: auth.url,
  });
  const service = makeService();
  const config = parseMcpConfig(serverBody(mcp.url), ".mcp.json");
  try {
    const started = await service.startAuth(serverBody(mcp.url), REDIRECT_URI);
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    await service.completeAuth({ state, code: "test-code" });

    // The session path (tool discovery through a manager) reads the same
    // store, so the grant works there without another sign-in.
    const manager = new McpManager(config, Deno.cwd(), service.oauth);
    try {
      const tools = await manager.listTools();
      assertEquals(tools.map((tool) => tool.name), ["echo"]);
      const status = manager.getStatus()[0]!;
      assertEquals(status.status, "ok");
      assertEquals(status.needsAuth, undefined);
    } finally {
      await manager.close();
    }
  } finally {
    await mcp.close();
    await auth.close();
  }
});

Deno.test("OAuth: a session's server without a grant reports needsAuth", async () => {
  const mcp = startFakeMcpServer({ token: "access-token-1" });
  const config = parseMcpConfig(serverBody(mcp.url), ".mcp.json");
  try {
    const manager = new McpManager(
      config,
      Deno.cwd(),
      new McpOAuthStore(createInMemorySettingsRepo()),
    );
    try {
      assertEquals(await manager.listTools(), []);
      const status = manager.getStatus()[0]!;
      assertEquals(status.status, "error");
      assertEquals(status.needsAuth, true);
    } finally {
      await manager.close();
    }
  } finally {
    await mcp.close();
  }
});

Deno.test("OAuth: the store keeps one record per server", () => {
  const store = new McpOAuthStore(createInMemorySettingsRepo());
  store.update("https://a.example/mcp", () => ({
    tokens: { access_token: "a-token" },
  }));
  store.update("https://a.example/mcp", (current) => ({
    ...current,
    clientInformation: { client_id: "client-a" },
  }));
  assertEquals(store.hasGrant("https://a.example/mcp"), true);
  assertEquals(store.hasGrant("https://b.example/mcp"), false);
  // The two writes are one record: tokens and registration survive each
  // other (a partial update would strand one of them).
  assertEquals(
    store.read("https://a.example/mcp")?.clientInformation?.client_id,
    "client-a",
  );
  assertEquals(
    store.read("https://a.example/mcp")?.tokens?.access_token,
    "a-token",
  );
  store.update("https://a.example/mcp", () => undefined);
  assertEquals(store.read("https://a.example/mcp"), undefined);
});
