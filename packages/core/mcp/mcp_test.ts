import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { CoreError, errorMessage } from "../errors.ts";
import {
  loadMcpConfig,
  McpConfigError,
  parseMcpConfig,
  serializeMcpConfig,
} from "./config.ts";
import type { McpServerConfig } from "./config.ts";
import { APP_MCP_SETTINGS_KEY } from "../shared/mod.ts";
import { McpManager } from "./manager.ts";
import { createMcpTools, sanitizeServerName } from "./tools.ts";
import { McpService } from "./service.ts";
import { probeMcpServer } from "./client.ts";
import { startFakeMcpServer } from "./fake-http.ts";
import { createInMemorySettingsRepo } from "../settings/repo.ts";
import { makeRealTempDir, removeDirRetry } from "../test-utils.ts";
import type { Workspace } from "../types/workspace.ts";

// --- config -----------------------------------------------------------------

Deno.test("parseMcpConfig normalizes stdio, http and disabled servers", () => {
  const config = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "server"],
          env: { TOKEN: "${LUMISCA_TEST_TOKEN}" },
          cwd: "sub",
        },
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer x" },
          enabled: false,
        },
      },
    }),
    ".mcp.json",
  );
  assertEquals(config.servers.length, 2);
  const fs = config.servers[0]!;
  assertEquals(fs.name, "fs");
  assertEquals(fs.type, "stdio");
  assertEquals(fs.command, "npx");
  assertEquals(fs.args, ["-y", "server"]);
  assertEquals(fs.cwd, "sub");
  assertEquals(fs.enabled, true);
  // Unset env var is left as-is.
  assertEquals(fs.env.TOKEN, "${LUMISCA_TEST_TOKEN}");
  const remote = config.servers[1]!;
  assertEquals(remote.type, "http");
  assertEquals(remote.url, "https://example.com/mcp");
  assertEquals(remote.headers.Authorization, "Bearer x");
  assertEquals(remote.enabled, false);
});

Deno.test("parseMcpConfig rejects invalid configurations", () => {
  const cases: Array<[string, string]> = [
    ["not json", "is not valid JSON"],
    ['{"other": 1}', 'missing the "mcpServers" key'],
    ['{"mcpServers": {}}', ""], // empty is fine
    ['{"mcpServers": {"s": {}}}', 'needs either "command"'],
    [
      '{"mcpServers": {"s": {"command": "x", "url": "https://y"}}}',
      'either "command" or "url", not both',
    ],
    [
      '{"mcpServers": {"s": {"command": "x", "args": "nope"}}}',
      '"s".args must be an array of strings',
    ],
  ];
  for (const [text, expected] of cases) {
    try {
      parseMcpConfig(text, ".mcp.json");
      if (expected) {
        assert(false, `expected an error for: ${text}`);
      }
    } catch (error) {
      assert(error instanceof McpConfigError, `wrong error type for: ${text}`);
      if (expected) {
        assert(
          error.message.includes(expected),
          `message "${error.message}" should include "${expected}"`,
        );
      }
    }
  }
});

Deno.test("loadMcpConfig reads the workspace file and expands env", async () => {
  const root = await makeRealTempDir("lumisca-mcp-");
  try {
    // Missing file → empty config.
    assertEquals(loadMcpConfig(root).servers.length, 0);
    Deno.env.set("LUMISCA_TEST_TOKEN", "secret-value");
    try {
      await Deno.writeTextFile(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            s: { command: "x", env: { TOKEN: "${LUMISCA_TEST_TOKEN}" } },
          },
        }),
      );
      const config = loadMcpConfig(root);
      assertEquals(config.servers[0]!.env.TOKEN, "secret-value");
      assertEquals(config.filePath, join(root, ".mcp.json"));
    } finally {
      Deno.env.delete("LUMISCA_TEST_TOKEN");
    }
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("serializeMcpConfig round-trips a config", () => {
  const config = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "s"], env: { A: "b" } },
        remote: { url: "https://x/mcp", enabled: false },
      },
    }),
    ".mcp.json",
  );
  const reparsed = parseMcpConfig(serializeMcpConfig(config), ".mcp.json");
  assertEquals(reparsed.servers.length, 2);
  assertEquals(reparsed.servers[0]!.command, "npx");
  assertEquals(reparsed.servers[0]!.env.A, "b");
  assertEquals(reparsed.servers[1]!.url, "https://x/mcp");
  assertEquals(reparsed.servers[1]!.enabled, false);
});

// --- stdio client + manager -------------------------------------------------

const FAKE_SERVER = join(
  import.meta.dirname!,
  "..",
  "..",
  "..",
  "scripts",
  "fake-mcp-server.ts",
);

/** Build a manager backed by the fake MCP server script. */

function makeManager(cwd: string, extra: Record<string, unknown> = {}) {
  const config = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        fake: {
          command: Deno.execPath(),
          args: ["run", FAKE_SERVER],
          ...extra,
        },
      },
    }),
    join(cwd, ".mcp.json"),
  );
  return new McpManager(config, cwd);
}

Deno.test("manager discovers MCP tools and calls them", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const manager = makeManager(cwd);
  try {
    const tools = await createMcpTools(manager);
    assertEquals(tools.length, 5);
    const names = tools.map((t) => t.name);
    assertEquals(names.includes("mcp__fake__echo"), true);
    assertEquals(names.includes("mcp__fake__fail"), true);
    const echo = tools.find((t) => t.name === "mcp__fake__echo")!;
    assertEquals(echo.label, "fake: echo");
    assert(echo.description.includes("Echo the given text"));
    assert(echo.description.includes("JSON Schema"));

    const result = await echo.execute("1", { text: "hi" }, undefined);
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    assertEquals(text, "echo:hi");
  } finally {
    await manager.close();
    await removeDirRetry(cwd);
  }
});

Deno.test("manager maps isError results to thrown errors", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const manager = makeManager(cwd);
  try {
    const tools = await createMcpTools(manager);
    const fail = tools.find((t) => t.name === "mcp__fake__fail")!;
    await assertRejects(() => fail.execute("1", {}, undefined), Error, "boom");
  } finally {
    await manager.close();
    await removeDirRetry(cwd);
  }
});

Deno.test("manager turns image content into a placeholder note", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const manager = makeManager(cwd);
  try {
    const tools = await createMcpTools(manager);
    const image = tools.find((t) => t.name === "mcp__fake__image")!;
    const result = await image.execute("1", {}, undefined);
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    assertEquals(text, "[image content: image/png]");
  } finally {
    await manager.close();
    await removeDirRetry(cwd);
  }
});

Deno.test("manager respawns a crashed server on the next call", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const manager = makeManager(cwd);
  try {
    const tools = await createMcpTools(manager);
    const crash = tools.find((t) => t.name === "mcp__fake__crash")!;
    const echo = tools.find((t) => t.name === "mcp__fake__echo")!;

    let message = "";
    try {
      await crash.execute("1", {}, undefined);
    } catch (error) {
      message = errorMessage(error);
    }
    // The SDK reports the transport failure; the exact wording is not
    // stable across versions, so just require a failure.
    assert(message.length > 0, "crash must fail the tool call");

    // The next call respawns the server and succeeds.
    const result = await echo.execute("2", { text: "again" }, undefined);
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    assertEquals(text, "echo:again");
  } finally {
    await manager.close();
    await removeDirRetry(cwd);
  }
});

Deno.test("aborting a call rejects and does not kill the server", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const manager = makeManager(cwd);
  try {
    const tools = await createMcpTools(manager);
    const slow = tools.find((t) => t.name === "mcp__fake__slow")!;
    const controller = new AbortController();
    const promise = slow.execute("1", {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    let message = "";
    try {
      await promise;
    } catch (error) {
      message = errorMessage(error);
    }
    assert(message.includes("aborted"), `message: ${message}`);

    // The server survives and keeps serving.
    const echo = tools.find((t) => t.name === "mcp__fake__echo")!;
    const result = await echo.execute("2", { text: "ok" }, undefined);
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    assertEquals(text, "echo:ok");
  } finally {
    await manager.close();
    await removeDirRetry(cwd);
  }
});

Deno.test("manager.close kills server processes", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const manager = makeManager(cwd);
  await createMcpTools(manager);
  assertEquals(manager.getStatus()[0]!.status, "ok");
  assertEquals(manager.getStatus()[0]!.toolCount, 5);
  await manager.close();
  // After close, the manager refuses further work.
  let message = "";
  try {
    await manager.listTools();
  } catch (error) {
    message = errorMessage(error);
  }
  assert(message.includes("closed"), `message: ${message}`);
  await removeDirRetry(cwd);
});

Deno.test("failed server startup is reported per server", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-" });
  const config = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        broken: { command: "definitely-not-a-real-binary", args: [] },
        fake: { command: Deno.execPath(), args: ["run", FAKE_SERVER] },
      },
    }),
    join(cwd, ".mcp.json"),
  );
  const manager = new McpManager(config, cwd);
  try {
    const tools = await createMcpTools(manager);
    // The healthy server's tools are still discovered.
    assertEquals(tools.some((t) => t.name === "mcp__fake__echo"), true);
    const status = manager.getStatus();
    const broken = status.find((s) => s.name === "broken")!;
    assertEquals(broken.status, "error");
    assert((broken.error ?? "").length > 0);
  } finally {
    await manager.close();
    await removeDirRetry(cwd);
  }
});

Deno.test("sanitizeServerName produces provider-safe names", () => {
  assertEquals(sanitizeServerName("my server"), "my_server");
  assertEquals(sanitizeServerName("github.com"), "github_com");
  assertEquals(sanitizeServerName("ok-1"), "ok-1");
  assertEquals(
    sanitizeServerName("x".repeat(100)),
    "x".repeat(64),
  );
});

// --- http client ------------------------------------------------------------

Deno.test("http servers work over streamable HTTP with session ids", async () => {
  // A minimal streamable-HTTP MCP server: issues a session id on
  // initialize, expects it back afterwards, answers tools/call over SSE.
  let sessionId: string | null = null;
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    if (req.method !== "POST") return new Response("nope", { status: 405 });
    const body = await req.json() as {
      id?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (body.method === "initialize") {
      sessionId = crypto.randomUUID();
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "http-fake", version: "1" },
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          },
        },
      );
    }
    if (body.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [{
            name: "ping",
            description: "Pings",
            inputSchema: { type: "object" },
          }],
        },
      });
    }
    if (body.method === "tools/call") {
      const sentSession = req.headers.get("mcp-session-id");
      const text = sentSession === sessionId
        ? "pong (session ok)"
        : `pong (session missing: ${sentSession ?? "none"})`;
      // Respond as SSE to exercise the SSE parser.
      return new Response(
        `event: message\ndata: ${
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text }] },
          })
        }\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `unknown: ${body.method}` },
    });
  });
  try {
    const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-http-" });
    const config = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: { url: `http://127.0.0.1:${server.addr.port}/mcp` },
        },
      }),
      join(cwd, ".mcp.json"),
    );
    const manager = new McpManager(config, cwd);
    try {
      const tools = await createMcpTools(manager);
      assertEquals(tools.length, 1);
      assertEquals(tools[0]!.name, "mcp__remote__ping");
      const result = await tools[0]!.execute("1", {}, undefined);
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      assertEquals(text, "pong (session ok)");
    } finally {
      await manager.close();
      await removeDirRetry(cwd);
    }
  } finally {
    await server.shutdown();
  }
});

// --- plugin integration (McpService.loadMergedConfig) -----------------------

Deno.test("loadMergedConfig merges app, workspace and plugin MCP servers", async () => {
  const root = await makeRealTempDir("lumisca-mcp-plugins-");
  const pluginDir = join(root, ".agents", "plugins", "demo");
  await Deno.mkdir(pluginDir, { recursive: true });
  await Deno.writeTextFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "demo",
    }),
  );
  await Deno.writeTextFile(
    join(pluginDir, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        "plugin-server": { type: "stdio", command: "./bin/server" },
        clash: { type: "stdio", command: "./bin/plugin-clash" },
        broken: { type: "stdio" }, // invalid entry: skipped with a warning
      },
    }),
  );
  await Deno.writeTextFile(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { clash: { command: "workspace-clash" } } }),
  );

  const settings = createInMemorySettingsRepo();
  settings.set(
    APP_MCP_SETTINGS_KEY,
    JSON.stringify({
      mcpServers: {
        "app-server": { command: "npx", args: ["-y", "app"] },
        clash: { command: "app-clash" },
      },
    }),
  );
  const workspace: Workspace = {
    id: "w",
    name: "w",
    folders: [root],
    createdAt: 0,
    chat: false,
  };
  const service = new McpService({
    settings,
    listSessions: () => [],
    agentMcpStatus: () => null,
    requireWorkspace: () => workspace,
    applySessionChange: () => {},
    refreshSessionMcp: () => {},
  });

  const merged = service.loadMergedConfig(workspace);
  const names = merged.config.servers.map((s) => s.name);
  assertEquals(names, ["app-server", "clash", "plugin-server"]);
  // Explicit user configuration (workspace over app) wins over plugins.
  const clash = merged.config.servers.find((s) => s.name === "clash")!;
  assertEquals(clash.command, "workspace-clash");
  // Plugin servers get the plugin root as cwd, PLUGIN_ROOT and PLUGIN_DATA.
  const plugin = merged.config.servers.find((s) => s.name === "plugin-server")!;
  assertEquals(plugin.command, join(pluginDir, "bin", "server"));
  assertEquals(plugin.cwd, pluginDir);
  assertEquals(plugin.env.PLUGIN_ROOT, pluginDir);
  // The broken plugin entry is reported, not fatal.
  assertEquals(merged.errors, [
    'Plugin "demo": MCP server "broken" is invalid; entry skipped',
  ]);
});

// --- connection test (the settings UI's "test" button) ----------------------

const FAKE_HANG = join(
  import.meta.dirname!,
  "..",
  "..",
  "..",
  "scripts",
  "fake-mcp-hang.ts",
);

/** A minimal stdio server config for the probe tests. */
function probeTarget(command: string, args: string[]): McpServerConfig {
  return {
    name: "probe",
    type: "stdio",
    command,
    args,
    env: {},
    headers: {},
    enabled: true,
  };
}

/** An McpService for the testServer tests: only the parse/probe path is
 * exercised, so the configuration surface stays empty. */
function makeTestService(): McpService {
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

Deno.test("probeMcpServer lists the server's tools", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-probe-" });
  try {
    const tools = await probeMcpServer(
      probeTarget(Deno.execPath(), ["run", FAKE_SERVER]),
      cwd,
    );
    assertEquals(tools.map((t) => t.name).sort(), [
      "crash",
      "echo",
      "fail",
      "image",
      "slow",
    ]);
    const echo = tools.find((t) => t.name === "echo")!;
    assert(echo.description?.includes("Echo the given text") ?? false);
  } finally {
    await removeDirRetry(cwd);
  }
});

Deno.test("probeMcpServer fails for a server that cannot start", async () => {
  await assertRejects(() =>
    probeMcpServer(
      probeTarget("lumisca-definitely-missing-command", []),
      Deno.cwd(),
      5_000,
    )
  );
});

Deno.test("a timed-out probe leaves no server process behind", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "lumisca-mcp-hang-" });
  const marker = join(cwd, "exited");
  try {
    await assertRejects(() =>
      probeMcpServer(
        probeTarget(Deno.execPath(), [
          "run",
          "--allow-write",
          FAKE_HANG,
          marker,
        ]),
        cwd,
        500,
      )
    );
    // Closing the transport ends the fixture's stdin and waits for the
    // child, so its exit marker is there by the time the probe settled.
    assertEquals(await Deno.readTextFile(marker), "exited");
  } finally {
    await removeDirRetry(cwd);
  }
});

Deno.test("testServer reports a server with its tools", async () => {
  const service = makeTestService();
  const result = await service.testServer(
    JSON.stringify({
      mcpServers: {
        fake: { command: Deno.execPath(), args: ["run", FAKE_SERVER] },
      },
    }),
  );
  assertEquals(result.ok, true);
  assertEquals(result.error, undefined);
  assertEquals(result.tools.length, 5);
  assertEquals(result.tools.some((t) => t.name === "echo"), true);
});

Deno.test("testServer tests a disabled server too", async () => {
  const service = makeTestService();
  const result = await service.testServer(
    JSON.stringify({
      mcpServers: {
        fake: {
          command: Deno.execPath(),
          args: ["run", FAKE_SERVER],
          enabled: false,
        },
      },
    }),
  );
  // Enabling is a separate decision: the point of the test is to see
  // whether the server works before turning it on.
  assertEquals(result.ok, true);
});

Deno.test("testServer reports an unreachable server as a result", async () => {
  const service = makeTestService();
  const result = await service.testServer(
    JSON.stringify({
      mcpServers: { broken: { command: "lumisca-definitely-missing-command" } },
    }),
    5_000,
  );
  assertEquals(result.ok, false);
  assertEquals(result.tools, []);
  assert((result.error?.length ?? 0) > 0);
});

Deno.test("testServer rejects invalid text and multi-server bodies", async () => {
  const service = makeTestService();
  // A malformed body is a caller error, not a test result.
  await assertRejects(() => service.testServer("not json"), CoreError);
  // One request describes one candidate server; a whole config would spawn
  // a process per entry.
  await assertRejects(
    () =>
      service.testServer(
        JSON.stringify({
          mcpServers: { a: { command: "x" }, b: { command: "y" } },
        }),
      ),
    CoreError,
  );
});

// --- HTTP transport (headers and the 401 answer) ----------------------------

Deno.test("an HTTP server receives the configured headers", async () => {
  const server = startFakeMcpServer();
  try {
    const tools = await probeMcpServer(
      {
        name: "probe",
        type: "http",
        args: [],
        env: {},
        url: server.url,
        headers: { Authorization: "Bearer test-token", "X-Extra": "1" },
        enabled: true,
      },
      Deno.cwd(),
      10_000,
    );
    assertEquals(tools.map((t) => t.name), ["echo"]);
    // The headers ride in `requestInit`: passing them as a top-level
    // transport option silently drops them (the SDK has no such option).
    const sent = server.requests[0]!;
    assertEquals(sent.headers.authorization, "Bearer test-token");
    assertEquals(sent.headers["x-extra"], "1");
  } finally {
    await server.close();
  }
});

Deno.test("testServer reports a 401 as needing a sign-in", async () => {
  const server = startFakeMcpServer({ token: "secret" });
  try {
    const service = makeTestService();
    const result = await service.testServer(
      JSON.stringify({ mcpServers: { probe: { url: server.url } } }),
      10_000,
    );
    // The server is reachable and healthy; it just wants the user to sign
    // in (see mcp/oauth.ts). The UI offers that instead of a raw 401 body.
    assertEquals(result.ok, false);
    assertEquals(result.needsAuth, true);
    assertEquals(result.tools, []);
  } finally {
    await server.close();
  }
});
