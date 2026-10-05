import { assertEquals } from "@std/assert";
import type { McpInfo, McpServerInfo, McpTestResult } from "@lumisca/core";
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
}

function makeApp(fake: FakeMcpApi) {
  const app = mcpRoutes(fake);
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
