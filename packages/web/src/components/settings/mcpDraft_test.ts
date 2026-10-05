import { assertEquals, assertNotEquals } from "@std/assert";
import type { McpServerInfo } from "../../types.ts";
import { mcpConfigFields, mcpDraftKey } from "./mcpDraft.ts";

/** A saved stdio server, as the settings list reports it. */
function server(patch: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: "fs",
    type: "stdio",
    command: "npx",
    args: ["-y", "server"],
    env: { TOKEN: "x" },
    headers: {},
    enabled: true,
    toolCount: 3,
    status: "ok",
    ...patch,
  };
}

Deno.test("mcpDraftKey ignores live status, so a refresh is not an edit", () => {
  // A server that has just been enabled reports its status later; that must
  // not invalidate the result of a test the user already ran.
  assertEquals(
    mcpDraftKey(server()),
    mcpDraftKey(server({ toolCount: 0, status: "not_started" })),
  );
  assertEquals(
    mcpDraftKey(server()),
    mcpDraftKey(server({ toolCount: 9, status: "error", error: "boom" })),
  );
});

Deno.test("mcpDraftKey changes with every field a connection uses", () => {
  const base = mcpDraftKey(server());
  const edits: Partial<McpServerInfo>[] = [
    { name: "other" },
    { type: "http", url: "https://example.com/mcp", command: undefined },
    { command: "node" },
    { args: ["-y"] },
    { env: { TOKEN: "y" } },
    { cwd: "/tmp" },
    { headers: { Authorization: "Bearer x" } },
    { enabled: false },
  ];
  for (const edit of edits) {
    assertNotEquals(mcpDraftKey(server(edit)), base, JSON.stringify(edit));
  }
});

Deno.test("mcpConfigFields covers exactly the stored fields", () => {
  assertEquals(Object.keys(mcpConfigFields(server())).sort(), [
    "args",
    "command",
    "cwd",
    "enabled",
    "env",
    "headers",
    "name",
    "type",
    "url",
  ]);
});
