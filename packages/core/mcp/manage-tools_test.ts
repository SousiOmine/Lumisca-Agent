import { assert, assertEquals, assertRejects } from "@std/assert";
import { toolText } from "../test-utils.ts";
import type { Tool } from "../tools/schema.ts";
import type { McpInfo, McpServerConfig, McpServerInfo } from "./config.ts";
import { parseMcpConfig } from "./config.ts";
import { createMcpAdminTools, type McpAdmin } from "./manage-tools.ts";
import type { McpTestResult } from "./service.ts";

/** What the fake admin was asked to do, so a test can prove that a refused
 * call changed nothing. */
interface AdminLog {
  added: McpServerConfig[];
  removed: string[];
  tested: string[];
}

/** An McpAdmin over a list the test controls: the tools' own contract
 * (validation order, what is saved after a failed test) is what these tests
 * cover — the service's config writes have their own tests in mcp_test.ts. */
function fakeAdmin(
  options: { servers?: McpServerInfo[]; test?: () => McpTestResult } = {},
): { admin: McpAdmin; log: AdminLog; serverNames: () => string[] } {
  const log: AdminLog = { added: [], removed: [], tested: [] };
  let servers = [...(options.servers ?? [])];
  const info = (): McpInfo => ({
    filePath: "app settings",
    exists: servers.length > 0,
    servers,
  });
  return {
    admin: {
      getAppMcpInfo: info,
      addAppServer: (server) => {
        log.added.push(server);
        servers = [
          ...servers,
          { ...server, toolCount: 0, status: "not_started" },
        ];
        return info();
      },
      removeAppServer: (name) => {
        log.removed.push(name);
        servers = servers.filter((server) => server.name !== name);
        return info();
      },
      testServer: (text) => {
        log.tested.push(text);
        return Promise.resolve(options.test?.() ?? { ok: true, tools: [] });
      },
    },
    log,
    serverNames: () => servers.map((server) => server.name),
  };
}

function serverInfo(
  name: string,
  overrides: Partial<McpServerInfo> = {},
): McpServerInfo {
  return {
    name,
    type: "stdio",
    enabled: true,
    args: [],
    env: {},
    headers: {},
    toolCount: 0,
    status: "ok",
    ...overrides,
  };
}

function byName(admin: McpAdmin): Map<string, Tool> {
  return new Map(createMcpAdminTools(admin).map((tool) => [tool.name, tool]));
}

// --- mcp_list ---------------------------------------------------------------

Deno.test("mcp_list reports names, state and live status", async () => {
  const { admin } = fakeAdmin({
    servers: [
      serverInfo("filesystem", { toolCount: 12 }),
      serverInfo("github", {
        type: "http",
        url: "https://example.com/mcp",
        status: "error",
        error: "Unauthorized",
        needsAuth: true,
      }),
      serverInfo("broken", { status: "error", error: "spawn npx ENOENT" }),
      serverInfo("old", { enabled: false }),
    ],
  });
  const list = byName(admin).get("mcp_list")!;
  const result = await list.execute("1", {} as never, undefined);
  const text = toolText(result);
  assert(text.includes("- filesystem (stdio): connected, 12 tool(s)"), text);
  assert(text.includes("- github (http): needs sign-in (Settings)"), text);
  assert(text.includes("- broken (stdio): failed: spawn npx ENOENT"), text);
  // A disabled server is not "connected with no tools".
  assert(text.includes("- old (stdio, disabled): disabled"), text);
  // The footer says which config these are, because a workspace's own file
  // can add servers this list does not show.
  assert(text.includes(".mcp.json"), text);
  assertEquals(result.details.count, 4);
});

Deno.test("mcp_list says when nothing is configured", async () => {
  const { admin } = fakeAdmin();
  const list = byName(admin).get("mcp_list")!;
  const result = await list.execute("1", {} as never, undefined);
  const text = toolText(result);
  assert(text.includes("No MCP servers are configured"), text);
  assert(text.includes("mcp_add"), text);
  assertEquals(result.details.count, 0);
});

// --- mcp_add ----------------------------------------------------------------

Deno.test("mcp_add refuses a shape the config cannot express", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: "  ", command: "npx" }, "name must not be empty"],
    [{ name: "x" }, "either command (stdio) or url (HTTP)"],
    [{ name: "x", command: "npx", url: "https://e/mcp" }, "not both"],
    [{ name: "x", command: "  " }, "command must not be empty"],
    [{ name: "x", url: "  " }, "url must not be empty"],
    [
      { name: "x", url: "https://e/mcp", args: ["a"] },
      "args belongs to a stdio server",
    ],
    [
      { name: "x", url: "https://e/mcp", env: { A: "1" } },
      "env belongs to a stdio server",
    ],
    [
      { name: "x", url: "https://e/mcp", cwd: "/tmp" },
      "cwd belongs to a stdio server",
    ],
    [
      { name: "x", command: "npx", headers: { A: "1" } },
      "headers belongs to an HTTP server",
    ],
  ];
  const add = byName(fakeAdmin().admin).get("mcp_add")!;
  for (const [args, expected] of cases) {
    await assertRejects(
      () => Promise.resolve().then(() => add.execute("1", args as never)),
      Error,
      expected,
    );
  }
});

Deno.test("mcp_add tests the connection, then saves exactly that server", async () => {
  const { admin, log } = fakeAdmin({
    test: () => ({
      ok: true,
      tools: [{ name: "read_file" }, { name: "write_file" }],
    }),
  });
  const add = byName(admin).get("mcp_add")!;
  const result = await add.execute(
    "1",
    {
      name: " filesystem ",
      command: " npx ",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "/data" },
      cwd: " /data ",
    } as never,
    undefined,
  );
  // The probe body is a one-server config with what will be stored.
  assertEquals(log.tested.length, 1);
  const probed = parseMcpConfig(log.tested[0]!, "probe").servers[0]!;
  assertEquals(probed.name, "filesystem");
  assertEquals(probed.type, "stdio");
  assertEquals(probed.command, "npx");
  assertEquals(probed.args, ["-y", "@modelcontextprotocol/server-filesystem"]);
  assertEquals(probed.env, { ROOT: "/data" });
  assertEquals(probed.cwd, "/data");
  assertEquals(probed.enabled, true);
  assertEquals(log.added.length, 1);
  assertEquals(log.added[0]!.name, "filesystem");
  const text = toolText(result);
  assert(text.includes('Added MCP server "filesystem" (stdio)'), text);
  assert(
    text.includes(
      "The connection test passed: 2 tool(s): read_file, write_file.",
    ),
    text,
  );
  assert(text.includes("tool_search"), text);
  assertEquals(result.details, {
    server: "filesystem",
    verified: true,
    toolCount: 2,
  });
});

Deno.test("mcp_add saves nothing when the connection test fails", async () => {
  const { admin, log } = fakeAdmin({
    test: () => ({ ok: false, tools: [], error: "spawn npx ENOENT" }),
  });
  const add = byName(admin).get("mcp_add")!;
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        add.execute("1", { name: "x", command: "npx" } as never),
      ),
    Error,
    "Nothing was saved",
  );
  assertEquals(log.added, []);
});

Deno.test("mcp_add saves a server that needs a sign-in, and says where", async () => {
  const { admin, log } = fakeAdmin({
    test: () => ({
      ok: false,
      tools: [],
      error: "Unauthorized",
      needsAuth: true,
    }),
  });
  const add = byName(admin).get("mcp_add")!;
  const result = await add.execute(
    "1",
    {
      name: "github",
      url: "https://api.example.com/mcp",
    } as never,
    undefined,
  );
  assertEquals(log.added.length, 1);
  assertEquals(log.added[0]!.type, "http");
  const text = toolText(result);
  assert(text.includes("Settings → MCP servers"), text);
  assert(text.includes("sign in"), text);
  // It was not "verified": the tools were never listed.
  assertEquals(result.details.verified, true);
  assertEquals(result.details.toolCount, undefined);
});

Deno.test("mcp_add skips the test with verify: false and says so", async () => {
  const { admin, log } = fakeAdmin();
  const add = byName(admin).get("mcp_add")!;
  const result = await add.execute(
    "1",
    {
      name: "slow",
      command: "npx",
      args: ["-y", "slow-to-download"],
      verify: false,
    } as never,
    undefined,
  );
  assertEquals(log.tested, []);
  assertEquals(log.added.length, 1);
  const text = toolText(result);
  assert(text.includes("Saved without a connection test."), text);
  assertEquals(result.details.verified, false);
});

Deno.test("mcp_add refuses a taken name before it connects to anything", async () => {
  const { admin, log } = fakeAdmin({ servers: [serverInfo("filesystem")] });
  const add = byName(admin).get("mcp_add")!;
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        add.execute("1", { name: "filesystem", command: "npx" } as never),
      ),
    Error,
    "already configured",
  );
  assertEquals(log.tested, []);
  assertEquals(log.added, []);
});

// --- mcp_remove -------------------------------------------------------------

Deno.test("mcp_remove removes one server and leaves the rest", async () => {
  const { admin, log } = fakeAdmin({
    servers: [serverInfo("a"), serverInfo("b")],
  });
  const remove = byName(admin).get("mcp_remove")!;
  const result = await remove.execute("1", { name: " b " } as never, undefined);
  assertEquals(log.removed, ["b"]);
  const text = toolText(result);
  assert(text.includes('Removed MCP server "b"'), text);
  assert(text.includes("1 server(s) remain"), text);
  assertEquals(result.details, { server: "b", remaining: 1 });
});

Deno.test("mcp_remove says when the config is empty again", async () => {
  const { admin } = fakeAdmin({ servers: [serverInfo("only")] });
  const remove = byName(admin).get("mcp_remove")!;
  const result = await remove.execute("1", { name: "only" } as never);
  assert(
    toolText(result).includes("No MCP servers are configured now."),
    toolText(result),
  );
});

Deno.test("mcp_remove refuses a name that is not configured", async () => {
  const { admin, log } = fakeAdmin({ servers: [serverInfo("a")] });
  const remove = byName(admin).get("mcp_remove")!;
  await assertRejects(
    () => Promise.resolve().then(() => remove.execute("1", { name: "nope" })),
    Error,
    'No MCP server named "nope"',
  );
  assertEquals(log.removed, []);
});
