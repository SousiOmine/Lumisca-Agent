import { join } from "node:path";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { MCP_SCHEMA_URL, parsePluginMcp } from "./mcp.ts";

function doc(mcpServers: unknown): string {
  return JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers });
}

// --- top-level document (disables MCP for the whole plugin) ------------------

Deno.test("parsePluginMcp rejects invalid JSON", () => {
  const result = parsePluginMcp("{ nope", "C:\\plugin", "p");
  assertFatal(result.fatal, "not valid JSON");
});

Deno.test("parsePluginMcp rejects a missing or mismatched $schema", () => {
  for (
    const text of [
      '{"mcpServers": {}}',
      '{"$schema": "https://x/1", "mcpServers": {}}',
    ]
  ) {
    const result = parsePluginMcp(text, "C:\\plugin", "p");
    assertFatal(result.fatal, "$schema");
  }
});

Deno.test("parsePluginMcp rejects a missing mcpServers", () => {
  const result = parsePluginMcp(
    JSON.stringify({ $schema: MCP_SCHEMA_URL }),
    "C:\\plugin",
    "p",
  );
  assertFatal(result.fatal, "mcpServers");
});

Deno.test("parsePluginMcp rejects unknown top-level fields", () => {
  const result = parsePluginMcp(
    JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: {}, extra: 1 }),
    "C:\\plugin",
    "p",
  );
  assertFatal(result.fatal, "unknown top-level");
});

Deno.test("parsePluginMcp accepts an empty mcpServers", () => {
  const result = parsePluginMcp(doc({}), "C:\\plugin", "p");
  assertEquals(result.fatal, undefined);
  assertEquals(result.servers, []);
});

// --- stdio servers -----------------------------------------------------------

Deno.test("parsePluginMcp maps a minimal stdio server", () => {
  const dataRoot = tempDataRoot();
  const result = parsePluginMcp(
    doc({ server: { type: "stdio", command: "npx" } }),
    "C:\\plugin",
    "my-tools",
    { pluginDataRoot: dataRoot },
  );
  assertEquals(result.fatal, undefined);
  assertEquals(result.warnings, []);
  assertEquals(result.servers.length, 1);
  const server = result.servers[0]!;
  assertEquals(server.name, "server");
  assertEquals(server.type, "stdio");
  assertEquals(server.command, "npx"); // bare command stays a token
  assertEquals(server.cwd, "C:\\plugin"); // default cwd is the plugin root
  assertEquals(server.env.PLUGIN_ROOT, "C:\\plugin");
  assertEquals(server.env.PLUGIN_DATA, join(dataRoot, "my-tools"));
  // PLUGIN_DATA dir was created for the stdio server.
  assert(Deno.statSync(join(dataRoot, "my-tools")).isDirectory);
});

Deno.test("parsePluginMcp resolves ./commands and ./cwd against the root", () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-plugin-" });
  const dataRoot = Deno.makeTempDirSync({ prefix: "lumisca-data-" });
  const result = parsePluginMcp(
    doc({
      server: {
        type: "stdio",
        command: "./bin/server",
        args: ["--port", "8080"],
        cwd: "./work",
      },
    }),
    root,
    "p",
    { pluginDataRoot: dataRoot },
  );
  const server = result.servers[0]!;
  assertEquals(server.command, join(root, "bin", "server"));
  assertEquals(server.cwd, join(root, "work"));
});

Deno.test("parsePluginMcp rejects commands that escape the plugin root", () => {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-plugin-" });
  // A "./" command that walks out of the root via ".." must be rejected;
  // bare commands like "../evil" are opaque tokens (platform search).
  const result = parsePluginMcp(
    doc({ server: { type: "stdio", command: "./../evil" } }),
    root,
    "p",
    { pluginDataRoot: Deno.makeTempDirSync({ prefix: "lumisca-data-" }) },
  );
  assertEquals(result.servers, []);
  assertEquals(result.warnings.length, 1);
  assert(result.warnings[0]!.includes("skipped"));
});

Deno.test("parsePluginMcp expands the two placeholders in args, env and cwd only", () => {
  const root = "C:\\plugin";
  const data = join("C:\\data", "p");
  const result = parsePluginMcp(
    doc({
      server: {
        type: "stdio",
        command: "run",
        args: ["${PLUGIN_ROOT}/a", "${PLUGIN_DATA}/b", "${OTHER}/c"],
        env: { CONF: "${PLUGIN_ROOT}/conf", PLAIN: "${UNSET}" },
        cwd: "${PLUGIN_DATA}/work",
      },
    }),
    root,
    "p",
    { pluginDataRoot: "C:\\data" },
  );
  const server = result.servers[0]!;
  assertEquals(server.args, [`${root}/a`, `${data}/b`, "${OTHER}/c"]);
  assertEquals(server.env.CONF, `${root}/conf`);
  assertEquals(server.env.PLAIN, "${UNSET}"); // only the two placeholders
  assertEquals(server.cwd, `${data}/work`);
});

Deno.test("parsePluginMcp rejects stdio entries with reserved env keys", () => {
  const result = parsePluginMcp(
    doc({
      server: { type: "stdio", command: "x", env: { PLUGIN_ROOT: "bad" } },
    }),
    "C:\\plugin",
    "p",
  );
  assertEquals(result.servers, []);
  assert(result.warnings[0]!.includes("skipped"));
});

Deno.test("parsePluginMcp rejects stdio entries with an invalid cwd", () => {
  const result = parsePluginMcp(
    doc({ server: { type: "stdio", command: "x", cwd: "../outside" } }),
    "C:\\plugin",
    "p",
  );
  assertEquals(result.servers, []);
  assert(result.warnings[0]!.includes("skipped"));
});

Deno.test("parsePluginMcp rejects a stdio entry without a command", () => {
  const result = parsePluginMcp(
    doc({ server: { type: "stdio", args: ["--x"] } }),
    "C:\\plugin",
    "p",
  );
  assertEquals(result.servers, []);
  assert(result.warnings[0]!.includes("skipped"));
});

Deno.test("parsePluginMcp rejects entries with unknown fields or transports", () => {
  for (
    const entry of [
      { type: "stdio", command: "x", bogus: 1 },
      { type: "unknown", command: "x" },
      { type: "stdio" },
      "not-an-object",
    ]
  ) {
    const result = parsePluginMcp(doc({ server: entry }), "C:\\plugin", "p");
    assertEquals(result.servers, [], JSON.stringify(entry));
    assertEquals(result.warnings.length, 1);
  }
});

Deno.test("parsePluginMcp isolates bad entries from good siblings", () => {
  const dataRoot = Deno.makeTempDirSync({ prefix: "lumisca-data-" });
  const result = parsePluginMcp(
    doc({
      good: { type: "stdio", command: "run" },
      bad: { type: "stdio" },
      remote: { type: "streamable-http", url: "https://example.com/mcp" },
    }),
    "C:\\plugin",
    "p",
    { pluginDataRoot: dataRoot },
  );
  assertEquals(result.fatal, undefined);
  assertEquals(result.servers.map((s) => s.name), ["good", "remote"]);
  assertEquals(result.warnings.length, 1);
});

// --- HTTP servers ------------------------------------------------------------

Deno.test("parsePluginMcp maps a streamable-http server", () => {
  const result = parsePluginMcp(
    doc({
      remote: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      },
    }),
    "C:\\plugin",
    "p",
  );
  assertEquals(result.fatal, undefined);
  assertEquals(result.warnings, []);
  const server = result.servers[0]!;
  assertEquals(server.type, "http");
  assertEquals(server.url, "https://example.com/mcp");
  assertEquals(server.headers, { Authorization: "Bearer x" });
});

Deno.test("parsePluginMcp skips a streamable-http entry without a url", () => {
  const result = parsePluginMcp(
    doc({ remote: { type: "streamable-http", headers: {} } }),
    "C:\\plugin",
    "p",
  );
  assertEquals(result.servers, []);
  assert(result.warnings[0]!.includes("skipped"));
});

Deno.test("parsePluginMcp validates but skips sse servers (unsupported)", () => {
  const result = parsePluginMcp(
    doc({ legacy: { type: "sse", url: "https://example.com/sse" } }),
    "C:\\plugin",
    "p",
  );
  assertEquals(result.fatal, undefined);
  assertEquals(result.servers, []);
  assert(result.warnings[0]!.includes("sse"));
  assert(result.warnings[0]!.includes("not support"));
});

Deno.test("parsePluginMcp does not create PLUGIN_DATA for http-only plugins", () => {
  const dataRoot = Deno.makeTempDirSync({ prefix: "lumisca-data-" });
  parsePluginMcp(
    doc({
      remote: { type: "streamable-http", url: "https://example.com/mcp" },
    }),
    "C:\\plugin",
    "p",
    { pluginDataRoot: dataRoot },
  );
  assertThrows(() => Deno.statSync(join(dataRoot, "p")));
});

function tempDataRoot(): string {
  return Deno.makeTempDirSync({ prefix: "lumisca-data-" });
}

function assertFatal(
  fatal: string | undefined,
  needle: string,
): void {
  assertEquals(
    typeof fatal === "string" && fatal.includes(needle),
    true,
    `expected fatal containing "${needle}": ${fatal}`,
  );
}
