import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { AgentMessage, BrowserBackend, ClientEvent } from "./mod.ts";
import { LumiscaCore } from "./mod.ts";
import { LumiscaDb } from "./mod.ts";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  serializeModelPreference,
  TOOL_BROWSER_OPEN,
  TOOL_CALL,
  TOOL_SEARCH,
} from "./shared.ts";

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

/** First-block text of every transcript message (test messages are
 * text-only). Narrowed explicitly: AgentMessage also includes custom
 * messages without `content` (e.g. BashExecutionMessage). */
function textsOf(messages: AgentMessage[]): string[] {
  return messages
    .filter(
      (m): m is Extract<AgentMessage, { content: unknown }> => "content" in m,
    )
    .map((m) => (m.content[0] as { text: string }).text);
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
      fauxToolCall("read", { path: join(outside, "secret.txt") }),
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

  // Inside the workspace reads work (folder-name-relative path).
  await Deno.writeTextFile(join(root, "inside.txt"), "hello");
  faux.setResponses([
    fauxAssistantMessage([
      fauxText("Reading."),
      fauxToolCall("read", { path: `${basename(root)}/inside.txt` }),
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

Deno.test("startPrompt steers a prompt sent while streaming", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  // A slow response keeps the session streaming while the second prompt
  // arrives; it must be steered into the running loop, not refused.
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
    fauxAssistantMessage("follow-up reply"),
  ]);
  core.startPrompt(session.id, "go");
  core.startPrompt(session.id, "again");

  await core.getAgent(session.id)!.waitForIdle();
  const agent = core.getAgent(session.id)!;
  assertEquals(agent.isStreaming, false);

  const userTexts = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text);
  assertEquals(userTexts, ["go", "again"]);

  // Close and reopen: the steered message is persisted exactly once.
  core.closeSession(session.id);
  core.openSession(session.id);
  const restored = core.getAgent(session.id)!.messages;
  const restoredUserTexts = restored
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text);
  assertEquals(restoredUserTexts, ["go", "again"]);

  core.close();
});

Deno.test("rewind deletes a user message and everything after it", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage("first reply"),
    fauxAssistantMessage("second reply"),
  ]);
  await core.prompt(session.id, "one");
  await core.prompt(session.id, "two");

  const agent = core.getAgent(session.id)!;
  assertEquals(agent.messages.length, 4);

  // Rewind the first user message: later turns are removed too.
  const firstUser = agent.messages[0]!;
  await core.rewind(session.id, firstUser.timestamp);
  assertEquals(agent.messages.length, 0);

  // Close and reopen: the database was truncated as well.
  core.closeSession(session.id);
  core.openSession(session.id);
  assertEquals(core.getAgent(session.id)!.messages.length, 0);

  core.close();
});

Deno.test("rewind mid-history keeps earlier turns and persists without duplicates", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage("first reply"),
    fauxAssistantMessage("second reply"),
  ]);
  await core.prompt(session.id, "one");
  // Distinct user-message timestamps (the rewind target is matched by
  // role + timestamp; the faux provider can finish a turn within one
  // millisecond).
  await new Promise((resolve) => setTimeout(resolve, 10));
  await core.prompt(session.id, "two");

  const events: string[] = [];
  core.subscribe((event) => {
    if (event.type === "messages_truncated") {
      events.push(`${event.sessionId}:${event.removed.length}`);
    }
  });

  const agent = core.getAgent(session.id)!;
  const secondUser = agent.messages[2]!;
  await core.rewind(session.id, secondUser.timestamp);

  // Only the first turn remains; the truncation event was emitted.
  const texts = textsOf(agent.messages);
  assertEquals(texts, ["one", "first reply"]);
  assert(
    events.includes(`${session.id}:2`),
    "messages_truncated event must be emitted",
  );

  // A new prompt after the rewind persists without duplicates or the
  // deleted turn coming back.
  faux.setResponses([fauxAssistantMessage("redo reply")]);
  await core.prompt(session.id, "one (fixed)");
  core.closeSession(session.id);
  core.openSession(session.id);
  const restored = core.getAgent(session.id)!.messages;
  assertEquals(restored.length, 4);
  assertEquals(textsOf(restored), [
    "one",
    "first reply",
    "one (fixed)",
    "redo reply",
  ]);

  core.close();
});

Deno.test("rewind while running aborts the run and truncates cleanly", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  // A slow response keeps the session streaming while the rewind arrives.
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
  ]);
  const userTimestamps: number[] = [];
  core.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "user") {
      userTimestamps.push(event.message.timestamp);
    }
  });
  core.startPrompt(session.id, "go");
  assertEquals(userTimestamps.length, 1);

  // Wait until the run has actually started streaming (the synthetic
  // announcement is synchronous; the run starts a microtask later).
  const agent = core.getAgent(session.id)!;
  while (!agent.isStreaming) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await core.rewind(session.id, userTimestamps[0]!);
  assertEquals(agent.isStreaming, false);
  // The aborted run's failure message is removed with the rewound turn.
  assertEquals(agent.messages.length, 0);

  core.closeSession(session.id);
  core.openSession(session.id);
  assertEquals(core.getAgent(session.id)!.messages.length, 0);

  core.close();
});

Deno.test("rewind of a queued steer drops it without resurrecting it", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

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
    fauxAssistantMessage("second reply"),
  ]);

  const userTimestamps: number[] = [];
  const truncations: Array<Array<{ role: string; timestamp: number }>> = [];
  core.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "user") {
      userTimestamps.push(event.message.timestamp);
    }
    if (event.type === "messages_truncated") {
      truncations.push(event.removed);
    }
  });
  core.startPrompt(session.id, "go");
  const agent = core.getAgent(session.id)!;
  while (!agent.isStreaming) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Wait past the millisecond of the first prompt: a rewind boundary at
  // the same timestamp would also match the earlier message.
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Sent while streaming: announced to clients, queued in the agent. The
  // last announced user message is the queued steer.
  core.startPrompt(session.id, "fix");
  const fixTimestamp = userTimestamps.at(-1)!;

  await core.rewind(session.id, fixTimestamp);
  // The run was aborted: only the first user message remains (the failure
  // message and the queued steer are gone).
  assertEquals(textsOf(agent.messages), ["go"]);
  // The steer itself never entered the transcript, but it was announced
  // to clients — the deletion notice must include it so they drop it
  // from the view.
  assert(
    truncations.at(-1)!.some(
      (m) => m.role === "user" && m.timestamp === fixTimestamp,
    ),
    "messages_truncated must include the queued steer",
  );

  // A later prompt must not resurrect the queued "fix".
  faux.setResponses([fauxAssistantMessage("redo reply")]);
  await core.prompt(session.id, "fresh");
  core.closeSession(session.id);
  core.openSession(session.id);
  const restored = core.getAgent(session.id)!.messages;
  assertEquals(textsOf(restored), ["go", "fresh", "redo reply"]);

  core.close();
});

Deno.test("rewind with an unknown timestamp throws not_found", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([fauxAssistantMessage("reply")]);
  await core.prompt(session.id, "hello");

  await assertRejects(
    () => core.rewind(session.id, 1),
    Error,
    "User message not found",
  );

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

Deno.test("hasConfiguredAuth ignores ambient env keys of built-in providers", async () => {
  const { core } = setup();
  const saved = new Map(
    ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]
      .map((k) => [k, Deno.env.get(k)] as const),
  );
  try {
    for (const k of saved.keys()) Deno.env.delete(k);
    assertEquals(await core.hasProviderAuth("anthropic"), false);
    assertEquals(await core.hasConfiguredAuth("anthropic"), false);

    // An env key set for other tools resolves for actual requests ...
    Deno.env.set("ANTHROPIC_API_KEY", "sk-env-only");
    assertEquals(await core.hasProviderAuth("anthropic"), true);
    // ... but must not make the provider appear as configured in Lumisca.
    assertEquals(await core.hasConfiguredAuth("anthropic"), false);

    // Storing the key inside Lumisca marks it configured; removing the
    // stored credential un-configures it again.
    await core.setProviderApiKey("anthropic", "sk-stored");
    assertEquals(await core.hasConfiguredAuth("anthropic"), true);
    await core.logoutProvider("anthropic");
    assertEquals(await core.hasConfiguredAuth("anthropic"), false);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    core.close();
  }
});

Deno.test("credentials are guarded on every settings surface", async () => {
  // File-backed settings so "nothing was stored" can be verified at rest.
  const dir = await Deno.makeTempDir({ prefix: "lumisca-settings-" });
  const core = LumiscaCore.open(
    join(dir, "test.db"),
    join(dir, "settings.jsonc"),
  );
  try {
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
    const stored = JSON.parse(
      Deno.readTextFileSync(join(dir, "settings.jsonc")),
    ) as Record<string, unknown>;
    assertEquals(stored["api_key:anthropic"], {
      key: "sk-test",
      type: "api_key",
    });
  } finally {
    core.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("database migration stamps user_version and is idempotent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-migrate-" });
  const path = join(dir, "test.db");

  const db1 = LumiscaDb.open(path);
  assertEquals(
    (db1.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    5,
  );
  db1.close();

  // Reopening an existing database must not re-run or fail migrations.
  const db2 = LumiscaDb.open(path);
  assertEquals(
    (db2.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    5,
  );
  db2.close();

  await Deno.remove(dir, { recursive: true });
});

Deno.test("migration drops the legacy settings table", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-migrate-" });
  const path = join(dir, "legacy.db");

  // A database created before settings moved to the settings file still
  // carries the settings table; opening it must drop it. It also predates
  // the custom-system-prompt removal, so its sessions table still has the
  // system_prompt_custom column, which the latest migration drops. The
  // workspaces table exists as in the real schema (chat workspaces were
  // added afterwards, so only the new migration touches it).
  const legacy = new DatabaseSync(path);
  legacy.exec(
    `CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  legacy.exec(
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      system_prompt TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  legacy.exec(
    "ALTER TABLE sessions ADD COLUMN system_prompt_custom INTEGER NOT NULL DEFAULT 0",
  );
  legacy.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  legacy.exec("PRAGMA user_version = 2");
  legacy.close();

  const db = LumiscaDb.open(path);
  const table = db.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
    )
    .get();
  assertEquals(table, undefined);
  const column = db.db
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .find((c) => c.name === "system_prompt_custom");
  assertEquals(column, undefined);
  // The chat-workspace migration ran on the legacy table too.
  const chatColumn = db.db
    .prepare("PRAGMA table_info(workspaces)")
    .all()
    .find((c) => c.name === "chat");
  assertEquals(chatColumn !== undefined, true, "chat column must be added");
  assertEquals(
    (db.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    5,
  );
  db.close();

  await Deno.remove(dir, { recursive: true });
});

// --- chat sessions (ワークスペースなしのシンプルチャット) ----------------

Deno.test("chat session: created without a workspace, chat prompt, no file tools", async () => {
  const { core, faux, providerId, modelId } = setup();

  // No workspaceId → a chat session in the folder-less chat workspace.
  const session = core.createSession({
    name: "chat",
    modelProvider: providerId,
    modelId,
  });
  assertEquals(session.chat, true);

  // The chat workspace is a singleton, created on first use and flagged,
  // but hidden from the user-facing workspace list.
  assertEquals(
    core.listWorkspaces().some((w) => w.chat),
    false,
    "the chat workspace must not appear in the public list",
  );
  const chatWs = core.getWorkspace(session.workspaceId)!;
  assertEquals(chatWs.chat, true);
  assertEquals(chatWs.folders.length, 0);

  // A second chat session reuses the same workspace.
  const second = core.createSession({ modelProvider: providerId, modelId });
  assertEquals(second.workspaceId, session.workspaceId);

  // The system prompt is the chat variant: no workspace folder list, no
  // "coding agent that works inside a workspace" framing.
  const agent = core.getAgent(session.id)!;
  const prompt = agent.agent.state.systemPrompt;
  assert(
    !prompt.includes(
      "You are Lumisca, a coding agent that works inside a workspace",
    ),
    "chat prompt must not use the coding-agent identity",
  );
  assert(
    !prompt.includes("The workspace contains these folders"),
    "chat prompt must not list workspace folders",
  );
  assert(
    prompt.includes("helpful AI assistant"),
    "chat prompt must use the chat identity",
  );
  assert(
    prompt.includes("Environment:"),
    "chat prompt keeps the environment section",
  );
  assert(
    !prompt.includes("[Background command ...]") &&
      !prompt.includes("[Task ...]") &&
      !prompt.includes("[Message from ...]"),
    "chat prompt must not describe notifications of tools it does not have",
  );

  // No file/shell/sub-agent tools; ask / todo / skill stay.
  const toolNames = agent.agent.state.tools.map((t) => t.name);
  for (
    const forbidden of [
      "read",
      "write",
      "edit",
      "list_dir",
      "grep",
      "glob",
      "bash",
      "async_bash",
      "eval",
    ]
  ) {
    assert(
      !toolNames.includes(forbidden),
      `chat session must not have the ${forbidden} tool`,
    );
  }
  assert(toolNames.includes("ask"), "chat session keeps the ask tool");
  assert(toolNames.includes("todo"), "chat session keeps the todo tool");

  // The chat session runs like any other.
  faux.setResponses([fauxAssistantMessage("hello from chat")]);
  await core.prompt(session.id, "Hi");
  const messages = core.getAgent(session.id)!.messages;
  assertEquals(messages.length, 2);
  assertEquals(
    (messages[1] as { content: Array<{ type: string; text: string }> })
      .content[0]!.text,
    "hello from chat",
  );

  // Close and reopen: history and the chat prompt snapshot are restored.
  core.closeSession(session.id);
  const reopened = await core.openSession(session.id);
  assertEquals(reopened.chat, true);
  const reopenedAgent = core.getAgent(session.id)!;
  assertEquals(reopenedAgent.agent.state.systemPrompt, prompt);
  assertEquals(reopenedAgent.messages.length, 2);

  core.close();
});

Deno.test("session_created event carries the decorated session (chat flag)", () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  try {
    const session = core.createSession({ modelProvider: providerId, modelId });
    const created = events.find(
      (e): e is Extract<ClientEvent, { type: "session_created" }> =>
        e.type === "session_created",
    );
    assertEquals(created !== undefined, true);
    // The event carries the same decorated shape as the API response —
    // raw rows must never leak the chat flag as undefined.
    assertEquals(created!.session.id, session.id);
    assertEquals(created!.session.chat, true);
  } finally {
    unsubscribe();
    core.close();
  }
});

Deno.test("chat workspace cannot be updated or deleted", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const session = core.createSession({ modelProvider: providerId, modelId });
  const chatWorkspace = core.getWorkspace(session.workspaceId)!;
  assertEquals(chatWorkspace.chat, true);

  assertThrows(
    () => core.deleteWorkspace(chatWorkspace.id),
    Error,
    "cannot be deleted",
  );
  await assertRejects(
    () => core.updateWorkspace(chatWorkspace.id, { name: "renamed" }),
    Error,
    "cannot be edited",
  );

  // Normal workspaces are unaffected.
  const { ws } = await makeWorkspace(core);
  const updated = await core.updateWorkspace(ws.id, { name: "renamed" });
  assertEquals(updated.name, "renamed");

  core.close();
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

Deno.test("generated system prompt is snapshotted at creation, not rebuilt on reopen", async () => {
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

  // Editing AGENTS.md must NOT affect the existing session: the prompt is
  // a snapshot taken at creation and reused verbatim on reopen.
  await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 3.\n");
  core.closeSession(session.id);
  await core.openSession(session.id);
  const reopened = core.getAgent(session.id)!;
  assertEquals(
    reopened.agent.state.systemPrompt.includes("Use Deno 2."),
    true,
    "the creation-time snapshot must be kept on reopen",
  );
  assertEquals(
    reopened.agent.state.systemPrompt.includes("Use Deno 3."),
    false,
    "AGENTS.md edits must not reach existing sessions",
  );

  // A session created after the edit picks up the new content.
  const fresh = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  assertEquals(
    core.getAgent(fresh.id)!.agent.state.systemPrompt.includes("Use Deno 3."),
    true,
    "new sessions must read the current AGENTS.md",
  );

  core.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test("personalization (machine AGENTS.md) is appended last and frozen per session", async () => {
  const faux = fauxProvider();
  const dir = await Deno.makeTempDir({ prefix: "lumisca-core-" });
  const core = LumiscaCore.open(
    join(dir, "lumisca.db"),
    join(dir, "settings.jsonc"),
  );
  core.models.models.setProvider(faux.provider);

  const root = await Deno.makeTempDir({ prefix: "lumisca-ws-" });
  await Deno.writeTextFile(join(root, "AGENTS.md"), "Workspace memory.\n");
  const ws = await core.createWorkspace("ws", [root]);

  // Personalization lives in AGENTS.md next to the settings file.
  const agentFile = join(dir, "AGENTS.md");
  await Deno.writeTextFile(agentFile, "Answer in Japanese.\n");
  assertEquals(core.getPersonalization().path, agentFile);
  assertEquals(core.getPersonalization().content, "Answer in Japanese.\n");

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  const prompt = core.getAgent(session.id)!.agent.state.systemPrompt;
  assertEquals(prompt.includes("Workspace memory."), true);
  assertEquals(prompt.includes("Answer in Japanese."), true);
  assertEquals(
    prompt.indexOf("Answer in Japanese.") > prompt.indexOf("Workspace memory."),
    true,
    "personalization must be appended after project memory",
  );

  // Changing the file must not affect the existing session...
  await Deno.writeTextFile(agentFile, "Answer in English.\n");
  core.closeSession(session.id);
  await core.openSession(session.id);
  const reopenedPrompt = core.getAgent(session.id)!.agent.state.systemPrompt;
  assertEquals(reopenedPrompt.includes("Answer in Japanese."), true);
  assertEquals(reopenedPrompt.includes("Answer in English."), false);

  // ...but a new session picks it up.
  const fresh = core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  assertEquals(
    core.getAgent(fresh.id)!.agent.state.systemPrompt.includes(
      "Answer in English.",
    ),
    true,
    "new sessions must read the current personalization",
  );

  // setPersonalization writes the file.
  core.setPersonalization("New instructions.\n");
  assertEquals(Deno.readTextFileSync(agentFile), "New instructions.\n");

  core.close();
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(root, { recursive: true });
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
    assertEquals(
      agent.agent.state.systemPrompt.includes("tool_search"),
      true,
      "system prompt must teach on-demand tool loading",
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
    await core.prompt(session.id, "Echo hi");

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
        await Deno.remove(root, { recursive: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

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

    // Sessions get the app-level tools (as the search/call pair over the
    // registry, not the MCP definitions themselves).
    const session = core.createSession({
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
    assertEquals(
      agent.agent.state.systemPrompt.includes("tool_search"),
      true,
      "system prompt must teach on-demand tool loading",
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
    await core.prompt(session.id, "List the available tools");
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
    // the search/call pair (previously the run started before the servers
    // had spawned and the tools were missing from the first request).
    const session = core.createSession({
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
    await core.prompt(session.id, "Echo first");

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
        await Deno.remove(root, { recursive: true });
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

Deno.test("browser tools are discoverable via tool_search, never preloaded", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const backend = new FakeBrowserBackend();
  core.setBrowserBackend(backend);
  try {
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    // The browser definitions stay in the session's registry (seeded by
    // the pool at open): the agent's tool set must not contain them —
    // finding them requires tool_search, exactly like MCP tools.
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("browser_")),
      false,
      "browser tools must stay out of the agent tool set",
    );
    // The registry is seeded synchronously at open (no MCP servers here,
    // so discovery contributes nothing) — the search/call pair is already
    // attached and the prompt teaches on-demand tool loading.
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        agent.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "search/call pair must be attached for the browser tools",
    );
    assertEquals(
      agent.agent.state.systemPrompt.includes("tool_search"),
      true,
      "system prompt must teach on-demand tool loading",
    );

    // The model searches for the tool, then calls it through tool_call;
    // the call reaches the browser backend.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "browser_open" }),
      ]),
      fauxAssistantMessage([
        fauxText("Opening."),
        fauxToolCall(TOOL_CALL, {
          name: TOOL_BROWSER_OPEN,
          args: { url: "http://127.0.0.1:5173/" },
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await core.prompt(session.id, "Open the app in the browser");

    assertEquals(backend.opens.length, 1);
    assertEquals(backend.opens[0]!.url, "http://127.0.0.1:5173/");
    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 2);
    const tr = toolResults[1] as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.isError, false, `tool call failed: ${tr.content[0]?.text}`);
    assert(
      tr.content[0]!.text.includes("Opened http://127.0.0.1:5173/"),
      `unexpected open result: ${tr.content[0]!.text}`,
    );
  } finally {
    core.close();
  }
});

Deno.test("detaching the browser backend removes browser tools on rebuild", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  core.setBrowserBackend(new FakeBrowserBackend());
  try {
    const session = core.createSession({
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
    // session): the seeded browser tools are removed from the registry,
    // so the rebuilt agent finds no discoverable tools at all — the pair
    // is not attached, exactly like a session that never had a backend.
    core.setBrowserBackend(undefined);
    core.setSessionModel(session.id, providerId, modelId);
    const detached = core.getAgent(session.id)!;
    assert(
      detached !== seeded,
      "setSessionModel must rebuild the agent",
    );
    assertEquals(
      detached.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      false,
      "an empty registry must not attach the search/call pair",
    );
    assertEquals(
      detached.agent.state.tools.some((t) => t.name.startsWith("browser_")),
      false,
    );
    assertEquals(
      detached.agent.state.systemPrompt.includes("tool_search"),
      false,
      "the on-demand-tools note must be gone with the registry",
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

// --- image analysis model (画像分析モデル) --------------------------------

/** Minimal 1x1 transparent PNG (67 bytes). */
const MINI_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A text-only main model plus a vision-capable analysis model on one
 * provider; the analysis model is selected through the model_image setting
 * (see ModelPreferencePanel in the web UI). */
function setupImageAnalysis() {
  const faux = fauxProvider({
    models: [
      { id: "text-only", input: ["text"] },
      { id: "vision", input: ["text", "image"] },
    ],
  });
  const core = LumiscaCore.forTesting([faux.provider]);
  core.setSetting(
    IMAGE_MODEL_KEY,
    serializeModelPreference({
      provider: faux.provider.id,
      modelId: "vision",
    }),
  );
  return { core, faux, providerId: faux.provider.id };
}

/** Capture every LLM call: model id + messages, in call order. */
type CapturedCall = {
  model: string;
  systemPrompt?: string;
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string; data?: string }>;
  }>;
};

function makeImageAnalysisResponses(
  captured: CapturedCall[],
  script: Array<
    (call: CapturedCall) => ReturnType<typeof fauxAssistantMessage>
  >,
) {
  return script.map(
    (step) =>
    (
      context: Context,
      _options: unknown,
      _state: unknown,
      model: { id: string },
    ) => {
      const call: CapturedCall = {
        model: model.id,
        systemPrompt: context.systemPrompt,
        messages: context.messages as CapturedCall["messages"],
      };
      captured.push(call);
      return step(call);
    },
  );
}

Deno.test("text-only model: user images are analyzed and passed as text", async () => {
  const { core, faux, providerId } = setupImageAnalysis();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "text-only",
  });

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    () => fauxAssistantMessage("analysis text"),
    () => fauxAssistantMessage("done"),
  ]));

  await core.prompt(session.id, "what is this?", [{
    type: "image",
    data: bytesToBase64(MINI_PNG),
    mimeType: "image/png",
  }]);

  assertEquals(captured.length, 2);
  // The analysis call went to the vision model with the image attached.
  assertEquals(captured[0]!.model, "vision");
  assertEquals(
    captured[0]!.messages[0]!.content.some(
      (b) => b.type === "image" && b.data !== undefined,
    ),
    true,
  );
  // The text-only main model got the analysis text instead of the image.
  assertEquals(captured[1]!.model, "text-only");
  const mainContent = captured[1]!.messages[0]!.content;
  assertEquals(mainContent.some((b) => b.type === "image"), false);
  assertEquals(
    mainContent.some(
      (b) => b.type === "text" && b.text?.includes("analysis text"),
    ),
    true,
  );
  // The transcript (what the UI shows and the DB stores) keeps the image.
  const userMessage = core.getAgent(session.id)!.messages[0]!;
  const userContent = (userMessage as { content: Array<{ type: string }> })
    .content;
  assertEquals(userContent.some((b) => b.type === "image"), true);
  core.close();
});

Deno.test("text-only model: read tool images are analyzed and passed as text", async () => {
  const { core, faux, providerId } = setupImageAnalysis();
  const { ws, root } = await makeWorkspace(core);
  await Deno.writeFile(join(root, "pic.png"), MINI_PNG);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "text-only",
  });

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    // Turn 1: the main model asks to read the image file.
    () =>
      fauxAssistantMessage([
        fauxText("Reading the image."),
        fauxToolCall("read", { path: join(root, "pic.png") }),
      ]),
    // Turn 2: the analysis model interprets the tool result image.
    () => fauxAssistantMessage("tool result described"),
    () => fauxAssistantMessage("done"),
  ]));

  await core.prompt(session.id, "read pic.png");

  assertEquals(captured.length, 3);
  assertEquals(captured[0]!.model, "text-only");
  assertEquals(captured[1]!.model, "vision");
  assertEquals(captured[2]!.model, "text-only");

  // The tool-result image reached the vision model as an image block.
  assertEquals(
    captured[1]!.messages[0]!.content.some((b) => b.type === "image"),
    true,
  );
  // The text-only main model saw the analysis text, not the image.
  const toolResult = captured[2]!.messages.find((m) => m.role === "toolResult");
  assertEquals(toolResult !== undefined, true);
  assertEquals(toolResult!.content.some((b) => b.type === "image"), false);
  assertEquals(
    toolResult!.content.some(
      (b) => b.type === "text" && b.text?.includes("tool result described"),
    ),
    true,
  );

  core.close();
});

// --- fast model title generation (高速モデルによるタイトル自動生成) -------

/** A main model plus a fast model on one provider; the fast model is
 * selected through the model_fast setting (see ModelPreferencePanel). */
function setupFastTitle() {
  const faux = fauxProvider({
    models: [
      { id: "main", input: ["text"] },
      { id: "fast", input: ["text"] },
    ],
  });
  const core = LumiscaCore.forTesting([faux.provider]);
  core.setSetting(
    FAST_MODEL_KEY,
    serializeModelPreference({
      provider: faux.provider.id,
      modelId: "fast",
    }),
  );
  return { core, faux, providerId: faux.provider.id };
}

Deno.test("fast model: first prompt auto-generates the session title", async () => {
  const { core, faux, providerId } = setupFastTitle();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "main",
  });
  assertEquals(session.name.startsWith("Session "), true); // provisional

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    // The title call (fast model) fires concurrently with the run.
    () => fauxAssistantMessage('"Fix login bug"'),
    () => fauxAssistantMessage("Hello!"),
  ]));

  await core.prompt(session.id, "Please fix the login bug");

  // The title call used the fast model and the first message text.
  assertEquals(captured.length, 2);
  assertEquals(captured[0]!.model, "fast");
  assertEquals(
    captured[0]!.messages[0]!.content[0]!.text,
    "Please fix the login bug",
  );
  assertEquals(captured[0]!.systemPrompt?.includes("title"), true);
  // The main run went to the session model.
  assertEquals(captured[1]!.model, "main");
  // The provisional name was replaced by the generated title.
  assertEquals(core.getSession(session.id)!.name, "Fix login bug");

  core.close();
});

Deno.test("startPrompt (web path): first prompt auto-generates the session title", async () => {
  const { core, faux, providerId } = setupFastTitle();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "main",
  });
  assertEquals(session.name.startsWith("Session "), true); // provisional

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    // The title call (fast model) fires concurrently with the run.
    () => fauxAssistantMessage('"Fix login bug"'),
    () => fauxAssistantMessage("Hello!"),
  ]));

  // The web/HTTP path is fire-and-forget (startPrompt): the title must
  // still be generated from the first message.
  core.startPrompt(session.id, "Please fix the login bug");
  await core.getAgent(session.id)!.waitForIdle();

  assertEquals(captured.length, 2);
  assertEquals(captured[0]!.model, "fast");
  assertEquals(
    captured[0]!.messages[0]!.content[0]!.text,
    "Please fix the login bug",
  );
  assertEquals(captured[1]!.model, "main");
  assertEquals(core.getSession(session.id)!.name, "Fix login bug");

  core.close();
});

Deno.test("no fast model: session keeps its provisional name", async () => {
  const { core, faux, providerId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: faux.getModel().id,
  });

  faux.setResponses([fauxAssistantMessage("ok")]);
  await core.prompt(session.id, "hello");

  assertEquals(core.getSession(session.id)!.name, session.name);
  assertEquals(session.name.startsWith("Session "), true);

  core.close();
});

Deno.test("reopened session with history does not regenerate the title", async () => {
  const { core, faux, providerId } = setupFastTitle();
  const { ws } = await makeWorkspace(core);

  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "main",
  });

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    () => fauxAssistantMessage("Title A"),
    () => fauxAssistantMessage("first reply"),
    () => fauxAssistantMessage("second reply"),
  ]));

  await core.prompt(session.id, "first message");
  assertEquals(core.getSession(session.id)!.name, "Title A");

  // Reopen with history and prompt again: no new title generation.
  core.closeSession(session.id);
  await core.openSession(session.id);
  await core.prompt(session.id, "second message");

  assertEquals(core.getSession(session.id)!.name, "Title A");
  assertEquals(captured.length, 3); // title + first run + second run only
  assertEquals(captured[2]!.model, "main");

  core.close();
});

/** Wait for the next `question` event of a session (the ask tool fired).
 * The run blocks until the test answers. */
function waitForQuestion(
  core: LumiscaCore,
  sessionId: string,
): Promise<Extract<ClientEvent, { type: "question" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("question event never arrived")),
      5000,
    );
    const unsubscribe = core.subscribe((event) => {
      if (event.type === "question" && event.sessionId === sessionId) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

Deno.test("ask tool blocks the run until the user answers, then continues", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask", {
        questions: [{
          id: "lang",
          question: "Which language?",
          options: [{ label: "Deno" }, { label: "Node" }],
        }],
      }),
    ]),
    fauxAssistantMessage("Great choice!"),
  ]);

  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));

  // The run blocks on the ask tool until the answer arrives.
  const run = core.prompt(session.id, "Which language should I use?");
  const question = await waitForQuestion(core, session.id);
  assertEquals(question.toolCallId.length > 0, true);
  core.answerQuestion(question.sessionId, question.toolCallId, [
    { id: "lang", values: ["Deno"] },
  ]);
  await run;

  // The tool result carried the answer and the run continued normally.
  const messages = core.getAgent(session.id)!.messages;
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 1);
  const resultText = (toolResults[0] as { content: Array<{ text: string }> })
    .content[0]!.text;
  assertEquals(resultText, "Answers from the user:\n- Which language?: Deno");
  const last = messages.at(-1) as { content: Array<{ text: string }> };
  assertEquals(last.content[0]!.text, "Great choice!");
  assertEquals(events.some((e) => e.type === "question"), true);

  unsubscribe();
  core.close();
});

Deno.test("todo tool plans, updates, and auto-advances the plan", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("todo", {
        action: "plan",
        phases: [{
          name: "実装",
          tasks: ["調査する", "実装する", "テストする"],
        }],
      }),
    ]),
    fauxAssistantMessage([
      fauxToolCall("todo", {
        action: "update",
        phase: "p1",
        task: "t1",
        status: "completed",
      }),
    ]),
    fauxAssistantMessage("finished!"),
  ]);

  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  await core.prompt(session.id, "Plan and track the work");

  // Every mutation emitted a `todo` snapshot event for this session.
  const todoEvents = events.filter(
    (e): e is Extract<ClientEvent, { type: "todo" }> => e.type === "todo",
  );
  assertEquals(todoEvents.length, 2);
  const planned = todoEvents[0]!.todos[0]!.tasks.map((t) => [t.name, t.status]);
  assertEquals(planned, [
    ["調査する", "pending"],
    ["実装する", "pending"],
    ["テストする", "pending"],
  ]);
  // Completing the current task auto-advanced to the next pending one.
  const updated = todoEvents.at(-1)!.todos[0]!.tasks.map((t) => [
    t.name,
    t.status,
  ]);
  assertEquals(updated, [
    ["調査する", "completed"],
    ["実装する", "in_progress"],
    ["テストする", "pending"],
  ]);

  // The run saw the plan in the tool results and continued normally.
  const messages = core.getAgent(session.id)!.messages;
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 2);
  const firstResult = (toolResults[0] as { content: Array<{ text: string }> })
    .content[0]!.text;
  assertEquals(
    firstResult,
    "Todo (1 phase, 3 tasks):\n[実装]\n" +
      "  [ ] 調査する (pending)\n  [ ] 実装する (pending)\n  [ ] テストする (pending)",
  );
  const last = messages.at(-1) as { content: Array<{ text: string }> };
  assertEquals(last.content[0]!.text, "finished!");

  unsubscribe();
  core.close();
});

Deno.test("rewind while a question is pending aborts the run cleanly", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask", {
        questions: [{
          id: "lang",
          question: "Which language?",
          options: [{ label: "Deno" }, { label: "Node" }],
        }],
      }),
    ]),
    fauxAssistantMessage("Great choice!"),
  ]);

  const run = core.prompt(session.id, "Which language should I use?");
  const question = await waitForQuestion(core, session.id);

  // Rewind must not hang on the blocked run: the pending ask is rejected
  // first, letting the loop unwind.
  const messages = core.getAgent(session.id)!.messages;
  const userMessage = messages.find((m) => m.role === "user")!;
  await core.rewind(session.id, userMessage.timestamp);

  // The ask is gone: a late answer is refused.
  assertThrows(
    () =>
      core.answerQuestion(session.id, question.toolCallId, [
        { id: "lang", values: ["Deno"] },
      ]),
    Error,
    "No pending question for tool call",
  );
  await run;

  core.close();
});
