import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { errorMessage } from "../errors.ts";
import {
  loadMcpConfig,
  McpConfigError,
  parseMcpConfig,
  serializeMcpConfig,
} from "./config.ts";
import { McpManager } from "./manager.ts";
import { createMcpTools, sanitizeServerName } from "./tools.ts";

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
  const root = realpathSync(await Deno.makeTempDir({ prefix: "lumisca-mcp-" }));
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

/** Windows can hold a directory handle briefly after a spawned child exits;
 * retry removal instead of failing the test. */
async function removeDirRetry(path: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await Deno.remove(path, { recursive: true }); // last attempt: surface errors
}

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
