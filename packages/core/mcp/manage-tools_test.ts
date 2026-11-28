import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Tool } from "../ports/tool.ts";
import type { McpServerConfig } from "../shared/mcp-config.ts";
import { toolText } from "../test-utils.ts";
import type { McpInfo, McpServerInfo } from "./config.ts";
import { parseMcpConfig } from "./config.ts";
import { createMcpAdminTools, type McpAdmin } from "./manage-tools.ts";
import type { McpTestResult } from "./service.ts";

/** What the fake admin was asked to do, so a test can prove that a refused
 * call changed nothing. */
interface AdminLog {
  added: Array<{ scope: "global" | "agent"; server: McpServerConfig }>;
  removed: Array<{ scope: "global" | "agent"; name: string }>;
  tested: Array<{ scope: "global" | "agent"; text: string }>;
}

/** An McpAdmin over two lists the test controls. Omitting `agentServers`
 * builds the code-mode surface (one list, no agent); passing it, even as an
 * empty array, builds a stella conversation's surface. The tools' own
 * contract — validation order, which list a server lands in, what is saved
 * after a failed test — is what these tests cover; the service's config
 * writes have their own tests in mcp_test.ts. */
function fakeAdmin(
  options: {
    servers?: McpServerInfo[];
    agentServers?: McpServerInfo[];
    test?: () => McpTestResult;
  } = {},
): {
  admin: McpAdmin;
  log: AdminLog;
  globalNames: () => string[];
  agentNames: () => string[];
} {
  const log: AdminLog = { added: [], removed: [], tested: [] };
  let global = [...(options.servers ?? [])];
  let agent = [...(options.agentServers ?? [])];
  const info = (servers: McpServerInfo[], filePath: string): McpInfo => ({
    filePath,
    exists: servers.length > 0,
    servers,
  });
  const withStatus = (server: McpServerConfig): McpServerInfo => ({
    ...server,
    toolCount: 0,
    status: "not_started",
  });
  const hasAgent = options.agentServers !== undefined;
  const probe = (scope: "global" | "agent", text: string) => {
    log.tested.push({ scope, text });
    return Promise.resolve(options.test?.() ?? { ok: true, tools: [] });
  };
  const admin: McpAdmin = {
    getAppMcpInfo: () => info(global, "app settings"),
    addAppServer: (server) => {
      log.added.push({ scope: "global", server });
      global = [...global, withStatus(server)];
      return info(global, "app settings");
    },
    removeAppServer: (name) => {
      log.removed.push({ scope: "global", name });
      global = global.filter((server) => server.name !== name);
      return info(global, "app settings");
    },
    testServer: (text) => probe("global", text),
    ...(hasAgent
      ? {
          getAgentMcpInfo: () => info(agent, "agent settings a1"),
          addAgentServer: (server: McpServerConfig) => {
            log.added.push({ scope: "agent", server });
            agent = [...agent, withStatus(server)];
            return info(agent, "agent settings a1");
          },
          removeAgentServer: (name: string) => {
            log.removed.push({ scope: "agent", name });
            agent = agent.filter((server) => server.name !== name);
            return info(agent, "agent settings a1");
          },
          testAgentServer: (text: string) => probe("agent", text),
        }
      : {}),
  };
  return {
    admin,
    log,
    globalNames: () => global.map((server) => server.name),
    agentNames: () => agent.map((server) => server.name),
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

test("mcp_list in code mode reports the shared list and its live status", async () => {
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
  assert(text.includes("- github (http): needs sign-in"), text);
  assert(text.includes("- broken (stdio): failed: spawn npx ENOENT"), text);
  // A disabled server is not "connected with no tools".
  assert(text.includes("- old (stdio): disabled"), text);
  assertEquals(result.details.count, 4);
});

test("mcp_list shows the agent's own list first and marks a shared override", async () => {
  const { admin } = fakeAdmin({
    servers: [serverInfo("github", { type: "http", url: "https://e/mcp" })],
    agentServers: [serverInfo("github", { toolCount: 3 })],
  });
  const list = byName(admin).get("mcp_list")!;
  const text = toolText(await list.execute("1", {} as never, undefined));
  const own = text.indexOf("This agent's own list");
  const shared = text.indexOf("The shared list");
  // The agent's own servers decide this conversation, so they come first.
  assert(own >= 0 && shared > own, text);
  assert(text.includes("- github (stdio): connected, 3 tool(s)"), text);
  // A shared entry of the same name is not the one in effect here.
  assert(text.includes("this conversation uses the agent's own server"), text);
});

test("mcp_list says when nothing is configured", async () => {
  const { admin } = fakeAdmin({ agentServers: [] });
  const list = byName(admin).get("mcp_list")!;
  const result = await list.execute("1", {} as never, undefined);
  const text = toolText(result);
  assert(text.includes("No MCP servers are configured"), text);
  assert(text.includes("mcp_add"), text);
  assertEquals(result.details.count, 0);
});

// --- mcp_add ----------------------------------------------------------------

test("mcp_add refuses a shape the config cannot express", async () => {
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
    [{ name: "x", command: "npx", scope: "elsewhere" }, "scope must be"],
  ];
  const add = byName(fakeAdmin({ agentServers: [] }).admin).get("mcp_add")!;
  for (const [args, expected] of cases) {
    await assertRejects(
      () => Promise.resolve().then(() => add.execute("1", args as never)),
      Error,
      expected,
    );
  }
});

test("a command server goes to the agent's own list and is probed there", async () => {
  const { admin, log, globalNames, agentNames } = fakeAdmin({
    agentServers: [],
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
  // A local process cannot run on the host for this conversation, so the
  // shared list is never considered.
  assertEquals(globalNames(), []);
  assertEquals(agentNames(), ["filesystem"]);
  assertEquals(
    log.tested.map((entry) => entry.scope),
    ["agent"],
  );
  const probed = parseMcpConfig(log.tested[0]!.text, "probe").servers[0]!;
  assertEquals(probed.name, "filesystem");
  assertEquals(probed.type, "stdio");
  assertEquals(probed.command, "npx");
  assertEquals(probed.args, ["-y", "@modelcontextprotocol/server-filesystem"]);
  assertEquals(probed.env, { ROOT: "/data" });
  assertEquals(probed.cwd, "/data");
  assertEquals(probed.enabled, true);
  const text = toolText(result);
  assert(text.includes("this agent's own list"), text);
  assert(text.includes("inside this agent's machine"), text);
  assert(
    text.includes(
      "The connection test passed: 2 tool(s): read_file, write_file.",
    ),
    text,
  );
  assertEquals(result.details, {
    server: "filesystem",
    scope: "agent",
    verified: true,
    toolCount: 2,
  });
});

test("a command server is refused for the shared list", async () => {
  // The shared list runs on the host. A local server there would escape the
  // machine, which is the one thing this conversation must not do.
  const { admin, log } = fakeAdmin({ agentServers: [] });
  const add = byName(admin).get("mcp_add")!;
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        add.execute("1", {
          name: "x",
          command: "npx",
          scope: "global",
        } as never),
      ),
    Error,
    "runs on the host",
  );
  assertEquals(log.added, []);
  assertEquals(log.tested, []);
});

test("an HTTP server defaults to the shared list", async () => {
  const { admin, log, globalNames, agentNames } = fakeAdmin({
    agentServers: [],
  });
  const add = byName(admin).get("mcp_add")!;
  const result = await add.execute(
    "1",
    { name: "github", url: "https://api.example.com/mcp" } as never,
    undefined,
  );
  assertEquals(globalNames(), ["github"]);
  assertEquals(agentNames(), []);
  assertEquals(
    log.tested.map((entry) => entry.scope),
    ["global"],
  );
  const text = toolText(result);
  assert(text.includes("the shared list"), text);
  assert(text.includes("on the host"), text);
  assertEquals(result.details.scope, "global");
});

test("an HTTP server with scope agent belongs to this agent alone", async () => {
  const { admin, globalNames, agentNames } = fakeAdmin({ agentServers: [] });
  const add = byName(admin).get("mcp_add")!;
  await add.execute(
    "1",
    {
      name: "github",
      url: "https://api.example.com/mcp",
      scope: "agent",
    } as never,
    undefined,
  );
  assertEquals(globalNames(), []);
  assertEquals(agentNames(), ["github"]);
});

test("mcp_add saves nothing when the connection test fails", async () => {
  const { admin, log } = fakeAdmin({
    agentServers: [],
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

test("a shared sign-in server points at Settings", async () => {
  const { admin, log } = fakeAdmin({
    agentServers: [],
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
    { name: "github", url: "https://api.example.com/mcp" } as never,
    undefined,
  );
  assertEquals(log.added.length, 1);
  const text = toolText(result);
  assert(text.includes("Settings → MCP servers"), text);
  assertEquals(result.details.verified, true);
  assertEquals(result.details.toolCount, undefined);
});

test("an agent's own sign-in server points at headers instead", async () => {
  // This list has no sign-in screen: a grant has nowhere to be completed.
  const { admin } = fakeAdmin({
    agentServers: [],
    test: () => ({
      ok: false,
      tools: [],
      error: "Unauthorized",
      needsAuth: true,
    }),
  });
  const add = byName(admin).get("mcp_add")!;
  const text = toolText(
    await add.execute(
      "1",
      { name: "github", url: "https://e/mcp", scope: "agent" } as never,
      undefined,
    ),
  );
  assert(text.includes("put the credential in headers"), text);
  assertEquals(text.includes("Settings →"), false);
});

test("mcp_add skips the test with verify: false and says so", async () => {
  const { admin, log } = fakeAdmin({ agentServers: [] });
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
  assert(toolText(result).includes("Saved without a connection test."));
  assertEquals(result.details.verified, false);
});

test("mcp_add refuses a taken name before it connects to anything", async () => {
  const { admin, log } = fakeAdmin({
    agentServers: [serverInfo("filesystem")],
  });
  const add = byName(admin).get("mcp_add")!;
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        add.execute("1", { name: "filesystem", command: "npx" } as never),
      ),
    Error,
    "already in the agent's own list",
  );
  assertEquals(log.tested, []);
  assertEquals(log.added, []);
});

test("code mode has no agent list, and says so when asked for one", async () => {
  const add = byName(fakeAdmin().admin).get("mcp_add")!;
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        add.execute("1", {
          name: "x",
          url: "https://e/mcp",
          scope: "agent",
        } as never),
      ),
    Error,
    "no agent of its own",
  );
});

// --- mcp_remove -------------------------------------------------------------

test("mcp_remove removes one server from the shared list", async () => {
  const { admin, log } = fakeAdmin({
    servers: [serverInfo("a"), serverInfo("b")],
  });
  const remove = byName(admin).get("mcp_remove")!;
  const result = await remove.execute("1", { name: " b " } as never, undefined);
  assertEquals(log.removed, [{ scope: "global", name: "b" }]);
  const text = toolText(result);
  assert(text.includes('Removed MCP server "b"'), text);
  assert(text.includes("every code-mode session"), text);
  assertEquals(result.details, { server: "b", scope: "global", remaining: 1 });
});

test("mcp_remove finds a name that only the agent's own list has", async () => {
  const { admin, log } = fakeAdmin({
    agentServers: [serverInfo("filesystem")],
  });
  const remove = byName(admin).get("mcp_remove")!;
  const result = await remove.execute("1", { name: "filesystem" } as never);
  assertEquals(log.removed, [{ scope: "agent", name: "filesystem" }]);
  assert(toolText(result).includes("Other agents and code mode are untouched"));
});

test("mcp_remove refuses to guess when both lists have the name", async () => {
  const { admin, log } = fakeAdmin({
    servers: [serverInfo("github")],
    agentServers: [serverInfo("github")],
  });
  const remove = byName(admin).get("mcp_remove")!;
  await assertRejects(
    () => Promise.resolve().then(() => remove.execute("1", { name: "github" })),
    Error,
    "configured in both lists",
  );
  assertEquals(log.removed, []);
  // With the scope it does remove exactly that one.
  await remove.execute("1", { name: "github", scope: "agent" });
  assertEquals(log.removed, [{ scope: "agent", name: "github" }]);
});

test("mcp_remove refuses a name that is not configured", async () => {
  const { admin, log } = fakeAdmin({
    servers: [serverInfo("a")],
    agentServers: [],
  });
  const remove = byName(admin).get("mcp_remove")!;
  await assertRejects(
    () => Promise.resolve().then(() => remove.execute("1", { name: "nope" })),
    Error,
    'No MCP server named "nope"',
  );
  assertEquals(log.removed, []);
});
