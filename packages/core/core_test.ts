import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { LumiscaCore } from "./mod.ts";
import { LumiscaDb } from "./mod.ts";

function setup() {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  return {
    core,
    faux,
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
  };
}

async function makeWorkspace(core: LumiscaCore, name = "ws") {
  const root = await Deno.makeTempDir({ prefix: "lumisca-core-" });
  const ws = await core.createWorkspace(name, [root]);
  return { ws, root };
}

Deno.test("workspace creation resolves folders and rejects missing ones", async () => {
  const { core } = setup();
  const root = await Deno.makeTempDir({ prefix: "lumisca-core-" });
  const ws = await core.createWorkspace("ws1", [root]);
  assertEquals(ws.folders.length, 1);
  assertEquals(ws.folders[0], realpathSync(root));

  await assertRejects(
    async () => {
      await core.createWorkspace("ws2", [join(root, "missing")]);
    },
    Error,
    "does not exist",
  );
  await Deno.remove(root, { recursive: true });
});

Deno.test("session prompt persists messages and restores them", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    name: "test",
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([fauxAssistantMessage("Hello from faux!")]);
  await core.prompt(session.id, "Hi");

  const agent = core.getAgent(session.id);
  assertEquals(agent !== undefined, true);
  const messages = agent!.messages;
  assertEquals(messages.length, 2);
  assertEquals(messages[0]!.role, "user");
  assertEquals(messages[1]!.role, "assistant");
  assertEquals(
    (messages[1] as { content: Array<{ type: string; text: string }> })
      .content[0]!.text,
    "Hello from faux!",
  );

  // Close and reopen — history must be restored from the database.
  core.closeSession(session.id);
  const reopened = await core.openSession(session.id);
  assertEquals(reopened.id, session.id);
  const restored = core.getAgent(session.id)!.messages;
  assertEquals(restored.length, 2);
  assertEquals(restored[1]!.role, "assistant");

  core.close();
});

Deno.test("sessions are listed and deleted", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const s1 = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const s2 = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  assertEquals(core.listSessions(ws.id).length, 2);
  core.deleteSession(s1.id);
  assertEquals(core.listSessions(ws.id).length, 1);
  assertEquals(core.getSession(s2.id) !== undefined, true);
  assertEquals(core.getSession(s1.id), undefined);

  core.close();
});

Deno.test("tools block file access outside the workspace", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const outside = await Deno.makeTempDir({ prefix: "lumisca-outside-" });
  await Deno.writeTextFile(join(outside, "secret.txt"), "secret");

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  // The model tries to read a file outside the workspace.
  faux.setResponses([
    fauxAssistantMessage([
      fauxText("Reading the file."),
      fauxToolCall("read_file", { path: join(outside, "secret.txt") }),
    ]),
    fauxAssistantMessage("Done."),
  ]);
  await core.prompt(session.id, "Read that file");

  const messages = core.getAgent(session.id)!.messages;
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 1);
  const tr = toolResults[0] as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assertEquals(tr.isError, true);
  assertEquals(tr.content[0]!.text.includes("outside the workspace"), true);

  // Inside the workspace reads work.
  await Deno.writeTextFile(join(root, "inside.txt"), "hello");
  faux.setResponses([
    fauxAssistantMessage([
      fauxText("Reading."),
      fauxToolCall("read_file", { path: "inside.txt" }),
    ]),
    fauxAssistantMessage("Read it."),
  ]);
  await core.prompt(session.id, "Read inside.txt");
  const messages2 = core.getAgent(session.id)!.messages;
  const tr2 = messages2.filter((m) => m.role === "toolResult").at(-1) as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assertEquals(tr2.isError, false);
  assertEquals(tr2.content[0]!.text.includes("hello"), true);

  core.close();
  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

Deno.test("model enablement is persisted", () => {
  const { core, providerId } = setup();
  const models = core.listModelsDetailed(providerId);
  assertEquals(models.length > 0, true);
  const target = models[0]!;

  // Default: enabled.
  assertEquals(core.isModelEnabled(providerId, target.id), true);

  // Disable: persisted.
  core.setModelEnabled(providerId, target.id, false);
  assertEquals(core.isModelEnabled(providerId, target.id), false);
  const after = core.listModelsDetailed(providerId);
  assertEquals(after.find((m) => m.id === target.id)?.enabled, false);

  // Re-enable: back to default.
  core.setModelEnabled(providerId, target.id, true);
  assertEquals(core.isModelEnabled(providerId, target.id), true);

  core.close();
});

Deno.test("session without model picks the last used model", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const first = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  assertEquals(first.modelProvider, providerId);
  assertEquals(first.modelId, modelId);

  // Second session without explicit model: inherits the last used one.
  const second = core.createSession({ workspaceId: ws.id });
  assertEquals(second.modelProvider, providerId);
  assertEquals(second.modelId, modelId);

  core.close();
});

Deno.test("getDefaultModel returns the last used model or a fallback", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  // No sessions yet: falls back to the first enabled model.
  const initial = core.getDefaultModel();
  assertEquals(initial !== null, true);
  assertEquals(core.isModelEnabled(initial!.provider, initial!.modelId), true);

  // After a session: the last used model wins.
  core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const last = core.getDefaultModel();
  assertEquals(last, {
    provider: providerId,
    modelId,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  });

  core.close();
});

Deno.test("session without model falls back to first enabled model", async () => {
  const { core, faux } = setup();
  const { ws } = await makeWorkspace(core);

  // With no prior sessions, the first provider's first enabled model is used.
  const session = core.createSession({ workspaceId: ws.id });
  assertEquals(session.modelProvider.length > 0, true);
  assertEquals(session.modelId.length > 0, true);
  assertEquals(
    core.isModelEnabled(session.modelProvider, session.modelId),
    true,
  );

  // The faux provider is still usable when selected explicitly.
  const explicit = core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  assertEquals(explicit.modelProvider, faux.provider.id);

  core.close();
});

Deno.test("workspace update rebuilds session tools", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });

  core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const updated = await core.updateWorkspace(ws.id, {
    name: "renamed",
    folders: [root, extra],
  });
  assertEquals(updated.name, "renamed");
  assertEquals(updated.folders.length, 2);

  const fetched = core.getWorkspace(ws.id);
  assertEquals(fetched !== undefined, true);
  assertEquals(fetched!.name, "renamed");
  assertEquals(fetched!.folders.length, 2);

  core.close();
  await Deno.remove(root, { recursive: true });
  await Deno.remove(extra, { recursive: true });
});

Deno.test("startPrompt throws while the session is streaming", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  // A slow response keeps the session streaming while we probe.
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
  ]);
  core.startPrompt(session.id, "go");
  assertThrows(
    () => core.startPrompt(session.id, "again"),
    Error,
    "already running",
  );

  await core.getAgent(session.id)!.waitForIdle();
  assertEquals(core.getAgent(session.id)!.isStreaming, false);
  core.close();
});

Deno.test("model switch and workspace update are refused while streaming", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
  ]);
  core.startPrompt(session.id, "go");

  assertThrows(
    () => core.setSessionModel(session.id, providerId, modelId),
    Error,
    "already running",
  );
  await assertRejects(
    () => core.updateWorkspace(ws.id, { folders: [root, extra] }),
    Error,
    "already running",
  );

  await core.getAgent(session.id)!.waitForIdle();

  // After the run finishes, both succeed.
  core.setSessionModel(session.id, providerId, modelId);
  const updated = await core.updateWorkspace(ws.id, { folders: [root, extra] });
  assertEquals(updated.folders.length, 2);

  core.close();
  await Deno.remove(root, { recursive: true });
  await Deno.remove(extra, { recursive: true });
});

Deno.test("workspaces require at least one folder", async () => {
  const { core } = setup();
  await assertRejects(
    () => core.createWorkspace("empty", []),
    Error,
    "at least one folder",
  );

  const { ws } = await makeWorkspace(core);
  await assertRejects(
    () => core.updateWorkspace(ws.id, { folders: [] }),
    Error,
    "at least one folder",
  );
  core.close();
});

Deno.test("credentials are guarded on every settings surface", async () => {
  const { core } = setup();
  await core.setProviderApiKey("anthropic", "sk-test");

  // Reading, writing, or deleting credentials through the generic settings
  // surface is refused (they have their own API).
  const refused = (fn: () => void) => {
    assertThrows(fn, Error, "credentials cannot be accessed");
  };
  refused(() => core.getSetting("api_key:anthropic"));
  refused(() => core.setSetting("api_key:anthropic", "x"));
  refused(() => core.deleteSetting("api_key:anthropic"));

  // listSettings never exposes them.
  assertEquals(core.listSettings().has("api_key:anthropic"), false);

  // The credential survives (the refused operations were no-ops).
  const row = core.db.db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("api_key:anthropic") as { value: string } | undefined;
  assertEquals(row !== undefined, true);

  core.close();
});

Deno.test("database migration stamps user_version and is idempotent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-migrate-" });
  const path = join(dir, "test.db");

  const db1 = LumiscaDb.open(path);
  assertEquals(
    (db1.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  db1.close();

  // Reopening an existing database must not re-run or fail migrations.
  const db2 = LumiscaDb.open(path);
  assertEquals(
    (db2.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  db2.close();

  await Deno.remove(dir, { recursive: true });
});

// --- thinking level (モデルごとの思考強度) --------------------------------

function setupReasoning() {
  // A reasoning model: without a thinkingLevelMap the provider defaults
  // apply, so off/minimal/low/medium/high are supported (not xhigh/max).
  const faux = fauxProvider({
    models: [{ id: "thinky", reasoning: true }],
  });
  const core = LumiscaCore.forTesting([faux.provider]);
  return {
    core,
    faux,
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
  };
}

Deno.test("sessions default to thinking off and expose supported levels", async () => {
  const { core, providerId, modelId } = setupReasoning();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  assertEquals(session.thinkingLevel, "off");
  assertEquals(session.thinkingLevels, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);

  // A non-reasoning model only supports "off".
  const plain = setup();
  const { ws: ws2 } = await makeWorkspace(plain.core);
  const s2 = plain.core.createSession({
    workspaceId: ws2.id,
    modelProvider: plain.providerId,
    modelId: plain.modelId,
  });
  assertEquals(s2.thinkingLevels, ["off"]);
  assertEquals(s2.thinkingLevel, "off");

  core.close();
  plain.core.close();
});

Deno.test("setModelThinkingLevel persists, clamps, and reflects on sessions", async () => {
  const { core, providerId, modelId } = setupReasoning();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  // Supported level is stored as-is.
  assertEquals(core.setModelThinkingLevel(providerId, modelId, "high"), "high");
  assertEquals(core.getSession(session.id)!.thinkingLevel, "high");

  // Unsupported levels clamp to the nearest supported one.
  assertEquals(core.setModelThinkingLevel(providerId, modelId, "max"), "high");

  // Non-reasoning models clamp everything to off.
  const plain = setup();
  assertEquals(
    plain.core.setModelThinkingLevel(plain.providerId, plain.modelId, "high"),
    "off",
  );
  assertEquals(
    plain.core.getModelThinkingLevel(plain.providerId, plain.modelId),
    "off",
  );

  core.close();
  plain.core.close();
});

Deno.test("setModelThinkingLevel rejects unknown levels and models", () => {
  const { core, providerId, modelId } = setupReasoning();
  assertThrows(
    () => core.setModelThinkingLevel(providerId, modelId, "turbo"),
    Error,
    "Unknown thinking level",
  );
  assertThrows(
    () => core.setModelThinkingLevel(providerId, "nope", "high"),
    Error,
    "Model not found",
  );
  core.close();
});

Deno.test("switching model picks up the new model's thinking level", async () => {
  const { core, providerId, modelId } = setupReasoning();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  core.setModelThinkingLevel(providerId, modelId, "medium");
  assertEquals(core.getSession(session.id)!.thinkingLevel, "medium");

  core.setSessionModel(session.id, providerId, modelId);
  assertEquals(core.getSession(session.id)!.thinkingLevel, "medium");

  core.close();
});

Deno.test("thinking level reaches the provider stream options", async () => {
  const faux = fauxProvider({ models: [{ id: "thinky", reasoning: true }] });
  const core = LumiscaCore.forTesting([faux.provider]);
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  core.setModelThinkingLevel(faux.provider.id, faux.getModel().id, "high");

  let receivedReasoning: unknown;
  faux.setResponses([
    (_context, options) => {
      receivedReasoning = (options as { reasoning?: unknown }).reasoning;
      return fauxAssistantMessage("ok");
    },
  ]);
  await core.prompt(session.id, "hi");
  assertEquals(receivedReasoning, "high");

  // A second run picks up a level change without rebuilding the agent.
  core.setModelThinkingLevel(faux.provider.id, faux.getModel().id, "off");
  receivedReasoning = undefined;
  faux.setResponses([
    (_context, options) => {
      receivedReasoning = (options as { reasoning?: unknown }).reasoning;
      return fauxAssistantMessage("ok");
    },
  ]);
  await core.prompt(session.id, "again");
  assertEquals(receivedReasoning, undefined);

  core.close();
});

Deno.test("thinking level change is refused while a session using the model streams", async () => {
  const faux = fauxProvider({ models: [{ id: "thinky", reasoning: true }] });
  const core = LumiscaCore.forTesting([faux.provider]);
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });

  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
  ]);
  core.startPrompt(session.id, "go");
  assertThrows(
    () =>
      core.setModelThinkingLevel(faux.provider.id, faux.getModel().id, "high"),
    Error,
    "already running",
  );

  await core.getAgent(session.id)!.waitForIdle();
  // Idle again: the change goes through.
  assertEquals(
    core.setModelThinkingLevel(faux.provider.id, faux.getModel().id, "high"),
    "high",
  );
  core.close();
});

Deno.test("generated system prompt includes AGENTS.md and is rebuilt on reopen", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const root = await Deno.makeTempDir({ prefix: "lumisca-core-" });
  await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 2.\n");
  const ws = await core.createWorkspace("ws", [root]);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const agent = core.getAgent(session.id)!;
  assertEquals(agent.agent.state.systemPrompt.includes("Use Deno 2."), true);
  assertEquals(session.systemPromptCustom, false);

  // Editing AGENTS.md must be reflected when the session is reopened.
  await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 3.\n");
  core.closeSession(session.id);
  await core.openSession(session.id);
  const reopened = core.getAgent(session.id)!;
  assertEquals(
    reopened.agent.state.systemPrompt.includes("Use Deno 3."),
    true,
    "AGENTS.md edit must be picked up on reopen",
  );
  assertEquals(
    reopened.agent.state.systemPrompt.includes("Use Deno 2."),
    false,
  );

  core.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test("custom system prompt is preserved across reopen", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    systemPrompt: "You are a specialized reviewer.",
  });
  assertEquals(session.systemPromptCustom, true);
  const agent = core.getAgent(session.id)!;
  assertEquals(
    agent.agent.state.systemPrompt,
    "You are a specialized reviewer.",
  );

  core.closeSession(session.id);
  const reopened = await core.openSession(session.id);
  assertEquals(reopened.systemPromptCustom, true);
  assertEquals(
    core.getAgent(session.id)!.agent.state.systemPrompt,
    "You are a specialized reviewer.",
  );

  core.close();
});

Deno.test("sessions attach MCP tools from .mcp.json and call them", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-core-" }),
  );
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
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  try {
    // MCP tools attach asynchronously; wait for the spawn + handshake.
    const agent = core.getAgent(session.id)!;
    const started = Date.now();
    while (
      !agent.agent.state.tools.some((t) => t.name === "mcp__fake__echo") &&
      Date.now() - started < 10000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "mcp__fake__echo"),
      true,
      "MCP tool never attached",
    );
    assertEquals(
      agent.agent.state.systemPrompt.includes("mcp__"),
      true,
      "system prompt must mention MCP boundary",
    );

    // The model calls the MCP tool and gets the server's answer.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Echoing."),
        fauxToolCall("mcp__fake__echo", { text: "hi" }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await core.prompt(session.id, "Echo hi");

    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 1);
    const tr = toolResults[0] as {
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.content[0]!.text, "echo:hi");
  } finally {
    core.close();
    // The MCP server process may hold the directory briefly on Windows.
    for (let i = 0; i < 20; i++) {
      try {
        await Deno.remove(root, { recursive: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

async function waitForMcpTools(
  agent: NonNullable<ReturnType<LumiscaCore["getAgent"]>>,
  toolName: string,
): Promise<void> {
  const started = Date.now();
  while (
    !agent.agent.state.tools.some((t) => t.name === toolName) &&
    Date.now() - started < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

Deno.test("app-level MCP config persists and applies to sessions", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-core-" }),
  );
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

    // Sessions get the app-level tools.
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    await waitForMcpTools(agent, "mcp__fake__echo");
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "mcp__fake__echo"),
      true,
    );
    assertEquals(
      agent.agent.state.systemPrompt.includes("mcp__"),
      true,
      "system prompt must mention MCP boundary",
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
        await Deno.remove(root, { recursive: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

Deno.test("workspace .mcp.json overrides same-named app servers", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-core-" }),
  );
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
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    // The workspace override wins: the fake server's tools appear even
    // though the app-level "fake" would fail to start.
    await waitForMcpTools(agent, "mcp__fake__echo");
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "mcp__app-only__echo"),
      true,
      "app-only server must still be merged in",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "mcp__fake__crash"),
      true,
    );
  } finally {
    core.close();
    for (let i = 0; i < 20; i++) {
      try {
        await Deno.remove(root, { recursive: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

Deno.test("first prompt waits for MCP tools to attach", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-core-" }),
  );
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
    // the MCP tools (previously the run started before the servers had
    // spawned and the tools were missing from the first request).
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Echoing."),
        fauxToolCall("mcp__fake__echo", { text: "first" }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await core.prompt(session.id, "Echo first");

    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 1);
    const tr = toolResults[0] as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.isError, false, `tool call failed: ${tr.content[0]?.text}`);
    assertEquals(tr.content[0]!.text, "echo:first");
  } finally {
    core.close();
    for (let i = 0; i < 20; i++) {
      try {
        await Deno.remove(root, { recursive: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
