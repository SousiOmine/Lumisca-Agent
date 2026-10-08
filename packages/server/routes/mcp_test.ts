import { assert, assertEquals } from "@std/assert";
import type {
  McpAuthSnapshot,
  McpInfo,
  McpServerInfo,
  McpTestResult,
} from "@lumisca/core";
import { type McpApi, mcpRoutes } from "./mcp.ts";
import { jsonError } from "./util.ts";

/** Deterministic stand-in for the core: it stores the raw config text and
 * answers the probe with whatever the test asked for. */
class FakeMcpApi implements McpApi {
  appText: string | undefined;
  private readonly workspaceTexts = new Map<string, string>();
  /** The body of the last test call, to pin what the route forwards. */
  tested: string | undefined;
  /** What the probe answers (the route passes it through untouched). */
  testResult: McpTestResult = { ok: true, tools: [{ name: "echo" }] };
  /** Sign-ins the routes may poll (the flow itself lives in the core). */
  authSessions = new Map<string, McpAuthSnapshot>();
  /** What the routes asked the core to do, to pin the forwarding. */
  authStarted: { text: string; redirectUri: string } | undefined;
  authCompleted: { state: string; code?: string; error?: string } | undefined;

  private static server(name: string): McpServerInfo {
    return {
      name,
      type: "stdio",
      command: `${name}-cmd`,
      args: [],
      env: {},
      headers: {},
      enabled: true,
      toolCount: 0,
      status: "not_started",
    };
  }

  getAppMcpInfo(): McpInfo {
    const exists = this.appText !== undefined;
    return {
      filePath: "app settings",
      exists,
      servers: exists ? [FakeMcpApi.server("app")] : [],
    };
  }
  setAppMcpConfig(text: string): McpInfo {
    this.appText = text;
    return this.getAppMcpInfo();
  }
  getMcpInfo(workspaceId: string): McpInfo {
    const text = this.workspaceTexts.get(workspaceId);
    return {
      filePath: `/w/${workspaceId}/.mcp.json`,
      exists: text !== undefined,
      servers: text === undefined ? [] : [FakeMcpApi.server("ws")],
    };
  }
  setMcpConfig(workspaceId: string, text: string): McpInfo {
    this.workspaceTexts.set(workspaceId, text);
    return this.getMcpInfo(workspaceId);
  }
  testMcpServer(text: string): Promise<McpTestResult> {
    this.tested = text;
    return Promise.resolve(this.testResult);
  }
  startMcpAuth(text: string, redirectUri: string): Promise<McpAuthSnapshot> {
    this.authStarted = { text, redirectUri };
    const snapshot: McpAuthSnapshot = {
      sessionId: "s1",
      serverUrl: "https://example.com/mcp",
      status: "waiting",
      authorizationUrl: "https://auth.example.com/authorize?state=st",
    };
    this.authSessions.set(snapshot.sessionId, snapshot);
    return Promise.resolve(snapshot);
  }
  getMcpAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.authSessions.get(sessionId);
  }
  cancelMcpAuth(sessionId: string): boolean {
    const snapshot = this.authSessions.get(sessionId);
    if (snapshot === undefined) return false;
    snapshot.status = "cancelled";
    return true;
  }
  completeMcpAuth(
    input: { state: string; code?: string; error?: string },
  ): Promise<McpAuthSnapshot | undefined> {
    this.authCompleted = input;
    const snapshot = this.authSessions.get("s1");
    if (snapshot === undefined || input.state !== "st") {
      return Promise.resolve(undefined);
    }
    if (input.error !== undefined) {
      snapshot.status = "error";
      snapshot.error = `authorization failed: ${input.error}`;
    } else {
      snapshot.status = "done";
    }
    return Promise.resolve(snapshot);
  }
}

function makeApp(fake: FakeMcpApi) {
  // The callback page renders in the app language (like the token page).
  const app = mcpRoutes(fake, () => "ja");
  app.onError((error, c) => jsonError(c, error));
  return app;
}

Deno.test("/mcp stores the raw config text and reports it back", async () => {
  const fake = new FakeMcpApi();
  const app = makeApp(fake);
  const text = '{"mcpServers":{"app":{"command":"npx"}}}\n';

  const put = await app.request("/mcp", { method: "PUT", body: text });
  assertEquals(put.status, 200);
  // Stored as sent, never re-serialized: the file's formatting is the
  // user's (or the UI's) business.
  assertEquals(fake.appText, text);
  assertEquals((await put.json() as McpInfo).servers.map((s) => s.name), [
    "app",
  ]);

  const get = await app.request("/mcp");
  assertEquals((await get.json() as McpInfo).exists, true);
});

Deno.test("/mcp and /mcp/test reject an empty body", async () => {
  const app = makeApp(new FakeMcpApi());

  const put = await app.request("/mcp", { method: "PUT", body: "   " });
  assertEquals(put.status, 400);

  const post = await app.request("/mcp/test", { method: "POST", body: "" });
  assertEquals(post.status, 400);
  assertEquals(await post.json(), { error: "JSON body is required" });
});

Deno.test("/mcp/test probes the single server of the raw body", async () => {
  const fake = new FakeMcpApi();
  const app = makeApp(fake);
  const text =
    '{"mcpServers":{"probe":{"command":"npx","args":["-y","server"]}}}';

  const res = await app.request("/mcp/test", { method: "POST", body: text });
  assertEquals(res.status, 200);
  // The probe sees exactly what a PUT would have stored.
  assertEquals(fake.tested, text);
  assertEquals(await res.json(), { ok: true, tools: [{ name: "echo" }] });
});

Deno.test("/mcp/test answers a failed probe as a 200 result", async () => {
  const fake = new FakeMcpApi();
  fake.testResult = { ok: false, tools: [], error: "spawn nope ENOENT" };
  const app = makeApp(fake);

  const res = await app.request("/mcp/test", {
    method: "POST",
    body: '{"mcpServers":{"probe":{"command":"nope"}}}',
  });
  // A server that does not answer is the outcome the button exists for, not
  // an API failure: the UI shows it inline instead of as a request error.
  assertEquals(res.status, 200);
  assertEquals(await res.json(), fake.testResult);
});

Deno.test("workspace .mcp.json routes keep their text per workspace", async () => {
  const app = makeApp(new FakeMcpApi());
  await app.request("/workspaces/w1/mcp", {
    method: "PUT",
    body: '{"mcpServers":{"ws":{"command":"x"}}}',
  });

  const info = await (await app.request("/workspaces/w1/mcp"))
    .json() as McpInfo;
  assertEquals(info.servers.map((s) => s.name), ["ws"]);
  // Another workspace keeps its own (absent) file.
  const other = await (await app.request("/workspaces/w2/mcp"))
    .json() as McpInfo;
  assertEquals(other.exists, false);
});

// --- OAuth sign-in routes ---------------------------------------------------

/** The single-server body the sign-in route takes (same shape as the test). */
const SIGN_IN_BODY =
  '{"mcpServers":{"probe":{"url":"https://example.com/mcp"}}}';

Deno.test("/mcp/auth registers the origin the browser is on", async () => {
  const fake = new FakeMcpApi();
  const app = makeApp(fake);

  const res = await app.request("/mcp/auth", {
    method: "POST",
    body: SIGN_IN_BODY,
    headers: {
      origin: "https://lumisca.example:8443",
      host: "lumisca.example:8443",
    },
  });
  assertEquals(res.status, 200);
  const snapshot = await res.json() as McpAuthSnapshot;
  assertEquals(snapshot.status, "waiting");
  assertEquals(
    snapshot.authorizationUrl,
    "https://auth.example.com/authorize?state=st",
  );
  assertEquals(fake.authStarted?.text, SIGN_IN_BODY);
  // The redirect must come back to the page the user is looking at: same
  // host, and https because the Origin said so.
  assertEquals(
    fake.authStarted?.redirectUri,
    "https://lumisca.example:8443/api/mcp/oauth/callback",
  );
});

Deno.test("/mcp/auth falls back to the request's own host", async () => {
  const fake = new FakeMcpApi();
  const app = makeApp(fake);

  // No Origin (a non-browser client): the validated Host is the origin.
  await app.request("/mcp/auth", {
    method: "POST",
    body: SIGN_IN_BODY,
    headers: { host: "127.0.0.1:8123" },
  });
  assertEquals(
    fake.authStarted?.redirectUri,
    "http://127.0.0.1:8123/api/mcp/oauth/callback",
  );

  // An Origin of another host is ignored (the redirect must not be
  // registered for a host this request did not come from).
  await app.request("/mcp/auth", {
    method: "POST",
    body: SIGN_IN_BODY,
    headers: { origin: "https://evil.example", host: "127.0.0.1:8123" },
  });
  assertEquals(
    fake.authStarted?.redirectUri,
    "http://127.0.0.1:8123/api/mcp/oauth/callback",
  );
});

Deno.test("/mcp/auth rejects an empty body", async () => {
  const app = makeApp(new FakeMcpApi());
  const res = await app.request("/mcp/auth", { method: "POST", body: "  " });
  assertEquals(res.status, 400);
});

Deno.test("/mcp/auth/:id answers the poll, the cancel and 404s when gone", async () => {
  const fake = new FakeMcpApi();
  const app = makeApp(fake);
  await app.request("/mcp/auth", { method: "POST", body: SIGN_IN_BODY });

  const poll = await app.request("/mcp/auth/s1");
  assertEquals(poll.status, 200);
  assertEquals((await poll.json() as McpAuthSnapshot).status, "waiting");

  const cancel = await app.request("/mcp/auth/s1/cancel", { method: "POST" });
  assertEquals(cancel.status, 200);
  const after = await app.request("/mcp/auth/s1");
  assertEquals((await after.json() as McpAuthSnapshot).status, "cancelled");

  assertEquals((await app.request("/mcp/auth/nope")).status, 404);
  assertEquals(
    (await app.request("/mcp/auth/nope/cancel", { method: "POST" })).status,
    404,
  );
});

Deno.test("/mcp/oauth/callback finishes the sign-in and answers a page", async () => {
  const fake = new FakeMcpApi();
  const app = makeApp(fake);
  await app.request("/mcp/auth", { method: "POST", body: SIGN_IN_BODY });

  const done = await app.request("/mcp/oauth/callback?code=abc&state=st");
  assertEquals(done.status, 200);
  assertEquals(fake.authCompleted, { state: "st", code: "abc" });
  assert((await done.text()).includes("認証が完了しました"));

  // The authorization server refused: reported as a failure page, and no
  // code is exchanged.
  const refused = await app.request(
    "/mcp/oauth/callback?error=access_denied&error_description=denied&state=st",
  );
  assertEquals(refused.status, 400);
  assertEquals(fake.authCompleted, {
    state: "st",
    error: "access_denied: denied",
  });
  assert((await refused.text()).includes("access_denied"));

  // An unknown state (expired, forged or already finished) is a 404 page.
  const unknown = await app.request("/mcp/oauth/callback?code=abc&state=nope");
  assertEquals(unknown.status, 404);
});
