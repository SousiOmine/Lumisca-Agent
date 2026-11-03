import { join } from "node:path";

import { assertEquals } from "@std/assert";

import { json, setup } from "./test-utils.ts";

import { removeDirRetry } from "@lumisca/core/test-utils";

Deno.test("app-level MCP config API applies to every workspace", async () => {
  const { core, server, base, faux } = await setup();
  const providerId = faux.provider.id;
  const modelId = faux.getModel().id;
  let root = "";
  try {
    const fakeServer = join(
      import.meta.dirname!,
      "..",
      "..",
      "scripts",
      "fake-mcp-server.ts",
    );
    // No app config yet.
    const empty = await json(base, "/api/mcp");
    assertEquals(empty.status, 200);
    assertEquals((await empty.json()).servers.length, 0);

    // Save an app-level server.
    const put = await json(base, "/api/mcp", {
      method: "PUT",
      body: JSON.stringify({
        mcpServers: {
          fake: { command: Deno.execPath(), args: ["run", fakeServer] },
        },
      }),
    });
    assertEquals(put.status, 200);
    const info = await put.json();
    assertEquals(info.servers.length, 1);
    assertEquals(info.servers[0]!.name, "fake");

    const invalid = await json(base, "/api/mcp", {
      method: "PUT",
      body: "nope",
    });
    assertEquals(invalid.status, 400);

    // A session in any workspace picks up the app-level tools (as the
    // search/call pair over the registry).
    root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();
    const session = await core.createSession({
      workspaceId: ws.id,
      name: "app-mcp",
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    const started = Date.now();
    while (
      !agent.agent.state.tools.some((t) => t.name === "tool_search") &&
      Date.now() - started < 10000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "tool_search") &&
        agent.agent.state.tools.some((t) => t.name === "tool_call"),
      true,
      "session must attach the search/call pair for app-level MCP tools",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("mcp__")),
      false,
      "MCP definitions must stay out of the agent tool set",
    );
  } finally {
    server.shutdown();
    // Await the MCP teardown (see the note above): the workspace folder
    // is the spawned server's working directory.
    await core.close();
    if (root) await removeDirRetry(root);
  }
});
