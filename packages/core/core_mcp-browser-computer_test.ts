import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { AgentMessage, BrowserBackend } from "./mod.ts";
import { LumiscaCore } from "./mod.ts";

import { TOOL_CALL, TOOL_PDF_READ_PAGES, TOOL_SEARCH } from "./shared/mod.ts";
import { MCP_TOOLS_PROVIDER, ON_DEMAND_TOOLS_NOTE } from "./mcp/context.ts";

import {
  makeRealTempDir,
  makeWorkspace,
  promptSession,
  removeDirRetry,
  setup,

} from "./test-utils.ts";

/** First-block text of every transcript message (test messages are
 * text-only). Narrowed explicitly: AgentMessage also includes custom
 * messages without `content` (e.g. BashExecutionMessage). */
function contextMessages(
  agent: { messages: AgentMessage[] },
  provider: string,
): Array<Extract<AgentMessage, { role: "context" }>> {
  return agent.messages.filter(
    (m): m is Extract<AgentMessage, { role: "context" }> =>
      m.role === "context" && m.provider === provider,
  );
}

/** The instruction context messages of a session (AGENTS.md + personal). */
class FakeBrowserBackend implements BrowserBackend {
  opens: Array<{ url: string; width?: number; height?: number }> = [];

  open(options: { url: string; width?: number; height?: number }) {
    this.opens.push(options);
    return Promise.resolve({
      url: options.url,
      title: "Lab",
      readyState: "complete",
    });
  }
  observe(): Promise<never> {
    throw new Error("unused");
  }
  act(): Promise<never> {
    throw new Error("unused");
  }
  wait(): Promise<never> {
    throw new Error("unused");
  }
  screenshot(): Promise<never> {
    throw new Error("unused");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Capture every LLM call: model id + messages, in call order. */
async function waitForSearchTools(
  agent: NonNullable<ReturnType<LumiscaCore["getAgent"]>>,
): Promise<void> {
  const started = Date.now();
  while (
    !agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
    Date.now() - started < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What the session's tool_search currently offers — the surface the model
 * itself uses to find MCP tools (empty when the pair is not attached). */
async function searchListing(
  agent: NonNullable<ReturnType<LumiscaCore["getAgent"]>>,
  query = "",
): Promise<string> {
  const search = agent.agent.state.tools.find((t) => t.name === TOOL_SEARCH);
  if (search === undefined) return "";
  const result = await search.execute(
    "search",
    query === "" ? {} : { query },
    undefined,
  );
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

/** In-memory computer host: serves one tiny display and records what the
 * tools asked it to do (the unused methods are never reachable here). */
Deno.test("sessions attach MCP tools from .mcp.json and call them", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = await makeRealTempDir("lumisca-core-");
  const fakeServer = join(
    import.meta.dirname!,
    "..",
    "..",
    "scripts",
    "fake-mcp-server.ts",
  );
  await Deno.writeTextFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: { command: Deno.execPath(), args: ["run", fakeServer] },
      },
    }),
  );
  const ws = await core.createWorkspace("ws", [root]);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  try {
    // MCP discovery is async; wait for the search/call pair. The MCP
    // definitions themselves never enter the agent's tool set — they stay
    // in the registry, discoverable through tool_search.
    const agent = core.getAgent(session.id)!;
    await waitForSearchTools(agent);
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        agent.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "search/call tools never attached",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("mcp__")),
      false,
      "MCP definitions must stay out of the agent tool set",
    );
    // The on-demand-tools contract never enters the prompt — its first
    // tokens are the provider's cached prefix — so the note travels as a
    // context message, published by the run below (checked after it).
    assertEquals(
      agent.agent.state.systemPrompt.includes("tool_search"),
      false,
      "the prompt must stay free of the on-demand-tools note",
    );

    // The model searches for the tool, then calls it through tool_call.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "echo" }),
      ]),
      fauxAssistantMessage([
        fauxText("Echoing."),
        fauxToolCall(TOOL_CALL, {
          name: "mcp__fake__echo",
          args: { text: "hi" },
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "Echo hi");

    // The run published the note as a context message ahead of its own
    // user message, and published it exactly once (the registry held tools
    // on the first check, so there is nothing to correct later).
    const notes = contextMessages(agent, MCP_TOOLS_PROVIDER);
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(notes[0]!.body, ON_DEMAND_TOOLS_NOTE);
    assert(
      agent.messages.indexOf(notes[0]!) <
        agent.messages.findIndex((m) => m.role === "user"),
      "the note must precede the run's user message",
    );

    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 2);
    const tr = toolResults[1] as {
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.content[0]!.text, "[mcp__fake__echo]\necho:hi");
  } finally {
    core.close();
    // The MCP server process may hold the directory briefly on Windows.
    for (let i = 0; i < 20; i++) {
      try {
        await removeDirRetry(root);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

Deno.test("app-level MCP config persists and applies to sessions", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = await makeRealTempDir("lumisca-core-");
  const fakeServer = join(
    import.meta.dirname!,
    "..",
    "..",
    "scripts",
    "fake-mcp-server.ts",
  );
  const ws = await core.createWorkspace("ws", [root]);
  try {
    // No app config yet.
    const empty = core.getAppMcpInfo();
    assertEquals(empty.servers.length, 0);
    assertEquals(empty.exists, false);

    // Save an app-level server (no workspace .mcp.json involved).
    const info = await core.setAppMcpConfig(
      JSON.stringify({
        mcpServers: {
          fake: { command: Deno.execPath(), args: ["run", fakeServer] },
        },
      }),
    );
    assertEquals(info.servers.length, 1);
    assertEquals(info.exists, true);
    assertEquals(core.getAppMcpInfo().servers[0]!.name, "fake");

    // Sessions get the app-level tools (as the search/call pair over the
    // registry, not the MCP definitions themselves).
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    await waitForSearchTools(agent);
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      true,
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("mcp__")),
      false,
      "MCP definitions must stay out of the agent tool set",
    );
    // The on-demand-tools contract is never appended to the prompt, whose
    // first tokens are the provider's cached prefix: the run below
    // publishes it as a context message ahead of its user message.
    assertEquals(
      agent.agent.state.systemPrompt.includes("tool_search"),
      false,
      "the prompt must stay free of the on-demand-tools note",
    );
    faux.setResponses([fauxAssistantMessage("ok")]);
    await promptSession(core, session.id, "hello");
    const notes = contextMessages(agent, MCP_TOOLS_PROVIDER);
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(
      notes[0]!.body,
      ON_DEMAND_TOOLS_NOTE,
      "the on-demand-tools note must be published as context",
    );

    // The generic settings surface refuses the MCP key (secrets may live
    // in env/headers).
    assertThrows(
      () => core.getSetting("mcp_servers"),
      Error,
      "MCP configuration cannot be accessed",
    );
    assertEquals(core.listSettings().has("mcp_servers"), false);
  } finally {
    core.close();
    for (let i = 0; i < 20; i++) {
      try {
        await removeDirRetry(root);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

Deno.test("an MCP config saved while a session streams reaches that session", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = await makeRealTempDir("lumisca-core-");
  const fakeServer = join(
    import.meta.dirname!,
    "..",
    "..",
    "scripts",
    "fake-mcp-server.ts",
  );
  const ws = await core.createWorkspace("ws", [root]);
  try {
    // A session with no MCP servers at all: nothing in its registry can
    // explain the discovery checked below.
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    await waitForSearchTools(agent);
    assertEquals(
      (await searchListing(agent)).includes("mcp__"),
      false,
      "the session must start without MCP tools",
    );

    // A slow answer keeps the session streaming while the config is saved —
    // the situation in which the save used to answer `conflict` (refused by
    // the streaming session) and silently dropped the edit.
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fauxAssistantMessage("slow reply");
      },
    ]);
    core.startPrompt(session.id, "go");
    while (!agent.isStreaming) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const info = await core.setAppMcpConfig(
      JSON.stringify({
        mcpServers: {
          fake: { command: Deno.execPath(), args: ["run", fakeServer] },
        },
      }),
    );
    assertEquals(info.servers.map((s) => s.name), ["fake"]);
    assertEquals(core.getAppMcpInfo().exists, true);
    // Saving did not disturb the run: the same agent, still streaming.
    assertEquals(core.getAgent(session.id), agent);
    assertEquals(agent.isStreaming, true);
    // The new server is this session's (the status is read from its
    // attachment, which the save swapped in place).
    assertEquals(agent.getMcpStatus()?.map((s) => s.name), ["fake"]);

    // Its tools are discoverable without a rebuild: the running session's
    // tool_search reads the session's registry, which the reconnect filled.
    let listing = "";
    for (let i = 0; i < 100; i++) {
      listing = await searchListing(agent);
      if (listing.includes("mcp__fake__echo")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(
      listing.includes("mcp__fake__echo"),
      `the new server's tools must be discoverable, got: ${listing}`,
    );
    while (agent.isStreaming) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // A run started afterwards — in the same session, no restart and no
    // reopen — calls the new tool.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Echoing."),
        fauxToolCall(TOOL_CALL, {
          name: "mcp__fake__echo",
          args: { text: "hi" },
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "Echo hi");
    const toolResults = agent.messages.filter((m) => m.role === "toolResult");
    const last = toolResults.at(-1) as {
      content: Array<{ text: string }>;
    };
    assertEquals(last.content[0]!.text, "[mcp__fake__echo]\necho:hi");
  } finally {
    core.close();
    // The MCP server process may hold the directory briefly on Windows.
    for (let i = 0; i < 20; i++) {
      try {
        await removeDirRetry(root);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

Deno.test("workspace .mcp.json overrides same-named app servers", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = await makeRealTempDir("lumisca-core-");
  const fakeServer = join(
    import.meta.dirname!,
    "..",
    "..",
    "scripts",
    "fake-mcp-server.ts",
  );
  // The app-level "fake" points at a binary that cannot start...
  await core.setAppMcpConfig(
    JSON.stringify({
      mcpServers: {
        fake: { command: "definitely-not-a-real-binary", args: [] },
        "app-only": { command: Deno.execPath(), args: ["run", fakeServer] },
      },
    }),
  );
  // ...but the workspace's own .mcp.json overrides it with a working one.
  await Deno.writeTextFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: { command: Deno.execPath(), args: ["run", fakeServer] },
      },
    }),
  );
  const ws = await core.createWorkspace("ws", [root]);
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    // The workspace override wins: browsing the registry must list the
    // working fake server's tools — they would be missing if the app-level
    // "fake" (a binary that cannot start) had won the merge.
    await waitForSearchTools(agent);
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Browsing."),
        fauxToolCall(TOOL_SEARCH, {}),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "List the available tools");
    const browse = core.getAgent(session.id)!.messages
      .filter((m) => m.role === "toolResult")
      .at(-1) as { content: Array<{ type: string; text: string }> };
    const text = browse.content[0]!.text;
    assert(text.includes("mcp__fake__echo"), "workspace override must win");
    assert(
      text.includes("mcp__app-only__echo"),
      "app-only server must still be merged in",
    );
    assert(text.includes("mcp__fake__crash"));
  } finally {
    core.close();
    for (let i = 0; i < 20; i++) {
      try {
        await removeDirRetry(root);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

Deno.test("first prompt waits for MCP tools to attach", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = await makeRealTempDir("lumisca-core-");
  const fakeServer = join(
    import.meta.dirname!,
    "..",
    "..",
    "scripts",
    "fake-mcp-server.ts",
  );
  await Deno.writeTextFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: { command: Deno.execPath(), args: ["run", fakeServer] },
      },
    }),
  );
  const ws = await core.createWorkspace("ws", [root]);
  try {
    // Prompt immediately — no waiting for the async attach: the session
    // must gate the run on MCP readiness so the FIRST turn already sees
    // the search/call pair (previously the run started before the servers
    // had spawned and the tools were missing from the first request).
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "echo" }),
      ]),
      fauxAssistantMessage([
        fauxText("Echoing."),
        fauxToolCall(TOOL_CALL, {
          name: "mcp__fake__echo",
          args: { text: "first" },
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "Echo first");

    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 2);
    const tr = toolResults[1] as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.isError, false, `tool call failed: ${tr.content[0]?.text}`);
    assertEquals(tr.content[0]!.text, "[mcp__fake__echo]\necho:first");
  } finally {
    core.close();
    for (let i = 0; i < 20; i++) {
      try {
        await removeDirRetry(root);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

// --- browser lab (ブラウザツール) ------------------------------------------

/** In-memory browser backend recording opens (the unused methods are
 * never reachable in this test — the tools are only exercised through
 * browser_open). */

Deno.test("detaching the browser backend removes browser tools on rebuild", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  core.setBrowserBackend(new FakeBrowserBackend());
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const seeded = core.getAgent(session.id)!;
    assertEquals(
      seeded.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      true,
      "seeded session must have the search/call pair",
    );

    // Detach and rebuild (a model switch rebuilds the agent of an open
    // session): the seeded browser tools are removed from the registry.
    // The registry is not empty afterwards — the PDF page-as-image tool
    // is seeded for every workspace session — so the search/call pair is
    // still attached and the on-demand-tools note is still published;
    // only the browser tools are gone.
    core.setBrowserBackend(undefined);
    core.setSessionModel(session.id, providerId, modelId);
    const detached = core.getAgent(session.id)!;
    assert(
      detached !== seeded,
      "setSessionModel must rebuild the agent",
    );
    assertEquals(
      detached.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      true,
      "the search/call pair stays attached for the PDF tool",
    );
    assertEquals(
      detached.agent.state.tools.some((t) => t.name.startsWith("browser_")),
      false,
    );
    assertEquals(
      detached.agent.state.tools.some((t) => t.name === TOOL_PDF_READ_PAGES),
      false,
      "the PDF tool must stay out of the agent tool set (discoverable via tool_search)",
    );
    // The on-demand-tools note follows the registry: it stays as long as
    // the registry holds the PDF tool. It is published as a context
    // message by the next run of the rebuilt session (never appended to
    // the prompt snapshot), so one prompt is run to observe it.
    faux.setResponses([fauxAssistantMessage("ok")]);
    await promptSession(core, session.id, "after detaching");
    const notes = contextMessages(
      core.getAgent(session.id)!,
      MCP_TOOLS_PROVIDER,
    );
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(
      notes[0]!.body,
      ON_DEMAND_TOOLS_NOTE,
      "the on-demand-tools note stays while the registry holds tools",
    );
    assertEquals(
      core.getAgent(session.id)!.agent.state.systemPrompt.includes(
        "tool_search",
      ),
      false,
      "the rebuilt prompt must stay free of the on-demand-tools note",
    );

    // Re-attaching restores the browser tools on the next rebuild.
    core.setBrowserBackend(new FakeBrowserBackend());
    core.setSessionModel(session.id, providerId, modelId);
    const restored = core.getAgent(session.id)!;
    assertEquals(
      restored.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      true,
      "re-attached session must have the search/call pair again",
    );
  } finally {
    core.close();
  }
});

// --- computer use (画面・マウス・キーボード) --------------------------------
