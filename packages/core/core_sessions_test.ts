import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  AgentMessage,
  ClientEvent,
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  Point,
  RawCapture,
  Rect,
} from "./mod.ts";
import { LumiscaCore } from "./mod.ts";
import { VISUALS_DIR_NAME } from "./mod.ts";
import { LumiscaDb } from "./mod.ts";
import { COMPACTION_KEEP_RECENT_PERCENT_KEY } from "./shared/settings-keys.ts";
import { SCHEMA_VERSION } from "./db/schema.ts";
import { LANGUAGE_KEY, TOOL_SEARCH, TOOL_SKILL } from "./shared/mod.ts";

import { DATE_PROVIDER } from "./agent/date-context.ts";

import {
  makeRealTempDir,
  makeWorkspace,
  MINI_PNG,
  promptSession,
  removeDirRetry,
  setup,
  toolText,
} from "./test-utils.ts";

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

/** The context messages (dynamic context snapshots) a session published
 * for one provider, in transcript order. */
function conversationMessages(
  agent: { messages: AgentMessage[] },
): AgentMessage[] {
  return agent.messages.filter((m) => m.role !== "context");
}

/** In-memory browser backend recording opens (the unused methods are
 * never reachable in this test — the tools are only exercised through
 * browser_open). */
const SMALL_WINDOW_MODEL_ID = "small-window";

/** Register a small-window faux model on the provider so a session can be
 * compacted by the real code path (the faux stream answers every call). */
function registerSmallWindowModel(
  faux: ReturnType<typeof fauxProvider>,
): void {
  const provider = faux.provider as unknown as {
    getModels(): Array<Record<string, unknown>>;
  };
  const original = provider.getModels;
  provider.getModels = () => [
    ...original.call(faux.provider),
    {
      id: SMALL_WINDOW_MODEL_ID,
      name: "small",
      api: "openai-completions",
      provider: "faux",
      // Big enough for the session's system prompt and tool schemas (an
      // envelope over the threshold can never be repaired by compacting
      // history), small enough that a few turns cross the threshold.
      contextWindow: 30_000,
      maxTokens: 3000,
    },
  ];
}

/** Answer a session's prompts with `turns` exchanges of a big user message
 * and a short reply, so the transcript holds several units — the shape a
 * long session has, and what makes a compaction possible at all (a single
 * oversized message cannot be repaired by replacing its neighbours).
 *
 * Once the history crosses the threshold the pre-step compaction fires
 * before a turn's own request, so each turn is served a summarization
 * answer followed by its reply. */
async function fillHistory(
  core: LumiscaCore,
  faux: ReturnType<typeof fauxProvider>,
  sessionId: string,
  turns: number,
): Promise<void> {
  faux.setResponses(
    Array.from(
      { length: turns * 2 },
      (_, i) =>
        fauxAssistantMessage([
          fauxText(i % 2 === 0 ? "## Summary\n- condensed" : "ok"),
        ]),
    ),
  );
  for (let i = 0; i < turns; i++) {
    await promptSession(core, sessionId, `turn ${i} ${"x".repeat(20_000)}`);
  }
}

/** Directory one session's visual assets live in (the store's layout: a
 * per-session directory beside the database). */
function visualDir(dbDir: string, sessionId: string): string {
  return join(dbDir, VISUALS_DIR_NAME, sessionId);
}

/** A file-backed core with a faux provider, a workspace, and one coding
 * session — the shape a real server runs. */
async function openFileBackedCore(
  dir: string,
): Promise<{ core: LumiscaCore; workspaceId: string; sessionId: string }> {
  const core = LumiscaCore.open(
    join(dir, "lumisca.db"),
    join(dir, "settings.jsonc"),
  );
  const faux = fauxProvider();
  core.models.models.setProvider(faux.provider);
  const workspaceDir = join(dir, "repo");
  await Deno.mkdir(workspaceDir, { recursive: true });
  const ws = await core.createWorkspace("ws", [workspaceDir]);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  return { core, workspaceId: ws.id, sessionId: session.id };
}

/** In-memory computer host: serves one tiny display and records what the
 * tools asked it to do (the unused methods are never reachable here). */
class FakeComputerHost implements ComputerHost {
  readonly captures: Rect[] = [];
  readonly actions: ComputerAction[] = [];

  capabilities = { windows: true, cursor: true };

  describe(): string {
    return "fake, 256×144 primary";
  }
  displays() {
    return [{
      index: 0,
      primary: true,
      bounds: { x: 0, y: 0, width: 256, height: 144 },
    }];
  }
  cursor(): Point | undefined {
    return { x: 3, y: 4 };
  }
  windows() {
    return [];
  }
  capture(region: Rect): Promise<RawCapture> {
    this.captures.push(region);
    return Promise.resolve({
      screen: region,
      pixels: new Uint8Array(region.width * region.height * 4),
      width: region.width,
      height: region.height,
    });
  }
  act(action: ComputerAction): Promise<ComputerActionResult> {
    this.actions.push(action);
    return Promise.resolve({
      cursor: { x: 3, y: 4 },
      steps: 8,
      durationMs: 104,
    });
  }
  close(): void {
    // nothing to release
  }
}

Deno.test("session prompt persists messages and restores them", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
    workspaceId: ws.id,
    name: "test",
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([fauxAssistantMessage("Hello from faux!")]);
  await promptSession(core, session.id, "Hi");

  const agent = core.getAgent(session.id);
  assertEquals(agent !== undefined, true);
  // The conversation is the exchange; the date and the on-demand-tools
  // note are publications that precede it (see conversationMessages).
  const messages = conversationMessages(agent!);
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
  const restored = conversationMessages(core.getAgent(session.id)!);
  assertEquals(restored.length, 2);
  assertEquals(restored[1]!.role, "assistant");

  core.close();
});

Deno.test("session revisions count the events a session emitted", async () => {
  // The count is what the web's probe compares against (see
  // LumiscaCore.getSessionRevision): 0 before anything happened, then one
  // step per announced event — a jump is what tells a client it lost a
  // frame.
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelId,
    modelProvider: providerId,
  });
  try {
    // Nothing has been announced for this session yet.
    assertEquals(core.getSessionRevision(session.id), 0);

    const seen: number[] = [];
    const unsubscribe = core.subscribe((event) => {
      if ("sessionId" in event && event.sessionId === session.id) {
        seen.push(core.getSessionRevision(session.id));
      }
    });
    faux.setResponses([fauxAssistantMessage("hi")]);
    await promptSession(core, session.id, "hello");
    unsubscribe();

    // The count advances by exactly one per event, so a subscriber sees 1,
    // 2, 3 … — the property the client's gap detection relies on.
    assert(seen.length > 0, "the run announced no events");
    assertEquals(seen[0], 1);
    assertEquals(seen.every((rev, i) => rev === i + 1), true);
    assert(core.getSessionRevision(session.id) >= seen.length);

    // Closing drops the count with the session's in-memory state: a client
    // still holding the old value sees a difference and re-reads.
    await core.closeSession(session.id);
    assertEquals(core.getSessionRevision(session.id), 0);
  } finally {
    core.close();
  }
});

Deno.test("sessions are listed and deleted", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const s1 = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const s2 = await core.createSession({
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

Deno.test("startPrompt steers a prompt sent while streaming", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
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

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage("first reply"),
    fauxAssistantMessage("second reply"),
  ]);
  await promptSession(core, session.id, "one");
  await promptSession(core, session.id, "two");

  const agent = core.getAgent(session.id)!;
  assertEquals(conversationMessages(agent).length, 4);

  // Rewind the first user message: later turns are removed too. The
  // context publications that went in before it are not part of a turn,
  // so they stay in the transcript.
  const firstUser = agent.messages.find((m) => m.role === "user")!;
  await core.rewind(session.id, firstUser.timestamp);
  assertEquals(conversationMessages(agent).length, 0);
  assert(
    agent.messages.every((m) => m.role === "context"),
    `only the context publications may remain: ${
      agent.messages.map((m) => m.role).join(",")
    }`,
  );

  // Close and reopen: the database was truncated as well.
  core.closeSession(session.id);
  core.openSession(session.id);
  assertEquals(conversationMessages(core.getAgent(session.id)!).length, 0);

  core.close();
});

Deno.test("rewind deletes a mode message (slash-command prompt) and everything after it", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([fauxAssistantMessage("plan reply")]);
  // The web path (startPrompt) with mode metadata: the transcript stores a
  // ModeMessage (role "mode") instead of a plain user message.
  core.startPrompt(session.id, "あなたは実装プランナーです。...", undefined, {
    modeId: "plan",
    optionId: "",
    modeLabel: "プランモード",
    shortText: "履歴機能を追加して",
  });
  await core.getAgent(session.id)!.waitForIdle();

  const agent = core.getAgent(session.id)!;
  const modeMessage = agent.messages.find((m) => m.role === "mode");
  assertEquals(modeMessage !== undefined, true);
  assertEquals(conversationMessages(agent).length, 2);

  // Rewind the mode message: the whole turn goes away (the UI's rewind
  // action on a mode message targets it like a user message). The context
  // publications that preceded it stay — they belong to no turn.
  await core.rewind(session.id, modeMessage!.timestamp);
  assertEquals(conversationMessages(agent).length, 0);

  // Close and reopen: the database was truncated as well.
  core.closeSession(session.id);
  core.openSession(session.id);
  assertEquals(conversationMessages(core.getAgent(session.id)!).length, 0);

  core.close();
});

Deno.test("rewind mid-history keeps earlier turns and persists without duplicates", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage("first reply"),
    fauxAssistantMessage("second reply"),
  ]);
  await promptSession(core, session.id, "one");
  // Distinct user-message timestamps (the rewind target is matched by
  // role + timestamp; the faux provider can finish a turn within one
  // millisecond).
  await new Promise((resolve) => setTimeout(resolve, 10));
  await promptSession(core, session.id, "two");

  const events: string[] = [];
  core.subscribe((event) => {
    if (event.type === "messages_truncated") {
      events.push(`${event.sessionId}:${event.removed.length}`);
    }
  });

  const agent = core.getAgent(session.id)!;
  const secondUser = agent.messages.filter((m) => m.role === "user")[1]!;
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
  await promptSession(core, session.id, "one (fixed)");
  core.closeSession(session.id);
  core.openSession(session.id);
  const restored = conversationMessages(core.getAgent(session.id)!);
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

  const session = await core.createSession({
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
  // Only the context publications that preceded it (date, on-demand tools)
  // survive: they are not part of the turn.
  assertEquals(conversationMessages(agent).length, 0);
  assert(
    agent.messages.every((m) => m.role === "context"),
    `only the context publications may remain: ${
      agent.messages.map((m) => m.role).join(",")
    }`,
  );

  core.closeSession(session.id);
  core.openSession(session.id);
  assertEquals(conversationMessages(core.getAgent(session.id)!).length, 0);

  core.close();
});

Deno.test("rewind of a queued steer drops it without resurrecting it", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
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
  await promptSession(core, session.id, "fresh");
  core.closeSession(session.id);
  core.openSession(session.id);
  const restored = core.getAgent(session.id)!.messages;
  assertEquals(textsOf(restored), ["go", "fresh", "redo reply"]);

  core.close();
});

Deno.test("rewind with an unknown timestamp throws not_found", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([fauxAssistantMessage("reply")]);
  await promptSession(core, session.id, "hello");

  await assertRejects(
    () => core.rewind(session.id, 1),
    Error,
    "User message not found",
  );

  core.close();
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
    await removeDirRetry(dir);
  }
});

Deno.test("database migration stamps user_version and is idempotent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-migrate-" });
  const path = join(dir, "test.db");

  const db1 = LumiscaDb.open(path);
  assertEquals(
    (db1.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    SCHEMA_VERSION,
  );
  db1.close();

  // Reopening an existing database must not re-run or fail migrations.
  const db2 = LumiscaDb.open(path);
  assertEquals(
    (db2.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    SCHEMA_VERSION,
  );
  db2.close();

  await removeDirRetry(dir);
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
  // The base schema created `messages` before user_version 2, so a real
  // database at this version has it (the context-usage migration reads it).
  legacy.exec(
    `CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`,
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
  // The goal-mode migration ran too: one active goal per session.
  const goalColumn = db.db
    .prepare("PRAGMA table_info(sessions)")
    .all()
    .find((c) => c.name === "goal_text");
  assertEquals(
    goalColumn !== undefined,
    true,
    "goal_text column must be added",
  );
  assertEquals(
    (db.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    SCHEMA_VERSION,
  );
  db.close();

  await removeDirRetry(dir);
});

// --- chat sessions (ワークスペースなしのシンプルチャット) ----------------

Deno.test("session language: the setting reaches an open session, not a frozen prompt", async () => {
  const { core, faux, providerId, modelId } = setup();
  try {
    // The language is a server setting (the settings dialog writes exactly
    // this). It is published as a context message, not baked into the
    // prompt, because it can change while a session lives (see
    // agent/language-context.ts).
    core.setSetting(LANGUAGE_KEY, "en");
    const english = await core.createSession({
      modelProvider: providerId,
      modelId,
    });
    // The provisional session name follows the same language (it is a
    // one-time write, so it keeps the language it was made in).
    assert(
      english.name.startsWith("Session "),
      `english session name: ${english.name}`,
    );

    // Switching the setting now reaches the session that is already open —
    // the reason the rule moved out of the prompt snapshot. The publication
    // happens before a run (like the date), so one is started.
    core.setSetting(LANGUAGE_KEY, "ja");
    faux.setResponses([fauxAssistantMessage("ok")]);
    await promptSession(core, english.id, "hello");
    const contexts = core.getAgent(english.id)!.messages
      .filter((message) => message.role === "context")
      .map((message) => message.body);
    assert(
      contexts.some((body) => body.includes("Write every reply in Japanese")),
      contexts.join("\n---\n"),
    );
  } finally {
    core.close();
  }
});

Deno.test("session_created event carries the decorated session (chat flag)", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  try {
    const session = await core.createSession({
      modelProvider: providerId,
      modelId,
    });
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

Deno.test("thinking level change while streaming applies from the next run without error", async () => {
  const faux = fauxProvider({ models: [{ id: "thinky", reasoning: true }] });
  const core = LumiscaCore.forTesting([faux.provider]);
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });

  let firstReasoning: unknown = "unset";
  faux.setResponses([
    async (_context, options) => {
      firstReasoning = (options as { reasoning?: unknown }).reasoning;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
  ]);
  core.startPrompt(session.id, "go");
  // Changing while streaming must not throw: the new level is persisted
  // and the open agent picks it up in place, while the in-flight run keeps
  // the level it started with.
  assertEquals(
    core.setModelThinkingLevel(faux.provider.id, faux.getModel().id, "high"),
    "high",
  );
  assertEquals(core.getSession(session.id)!.thinkingLevel, "high");
  assertEquals(
    core.getAgent(session.id)!.agent.state.thinkingLevel,
    "high",
  );

  await core.getAgent(session.id)!.waitForIdle();
  // The in-flight run started before the change, so it used the old level.
  assertEquals(firstReasoning, undefined);

  // The next run uses the new level without any rebuild.
  let secondReasoning: unknown = "unset";
  faux.setResponses([
    (_context, options) => {
      secondReasoning = (options as { reasoning?: unknown }).reasoning;
      return fauxAssistantMessage("ok");
    },
  ]);
  await promptSession(core, session.id, "again");
  assertEquals(secondReasoning, "high");
  core.close();
});

/** Poll until `check` holds, or fail the test. */
async function waitUntil(
  check: () => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test("model change while streaming is stored and applied as the run ends", async () => {
  // The regression this pins: switching the model while the session ran was a
  // 409 ("Session is already running"), so a user who wanted the next message
  // answered by another model had to wait and try again. The choice is stored
  // at once and the agent is rebuilt when the run ends — never refused, and
  // never replaced under a loop that is still executing.
  const faux = fauxProvider({
    models: [{ id: "faux" }, { id: "other" }],
  });
  const core = LumiscaCore.forTesting([faux.provider]);
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: "faux",
  });
  const running = core.getAgent(session.id)!;
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fauxAssistantMessage("slow reply");
    },
  ]);
  core.startPrompt(session.id, "go");

  // No error, and the row already carries the choice...
  core.setSessionModel(session.id, faux.provider.id, "other");
  assertEquals(core.getSession(session.id)!.modelId, "other");
  // ...while the agent the run belongs to is left alone.
  assertEquals(core.getAgent(session.id), running);

  await running.waitForIdle();
  // The rebuild follows the end of the run (it is emitted from the run's own
  // teardown, so it happens just after).
  await waitUntil(
    () => core.getAgent(session.id) !== running,
    "the agent to be rebuilt with the new model",
  );
  assertEquals(core.getSession(session.id)!.modelId, "other");
  core.close();
});

Deno.test("a run's transcript order is also its timestamp order", async () => {
  // The clients keep a window of the transcript and identify messages by role
  // + timestamp (see MessageIdentity): a view drops a live message older than
  // its newest one, and a resync merge anchors on those identities. So the
  // transcript's order must agree with its timestamps, or the prompt of a
  // fresh session lands before the context that introduced it (and drops out
  // of the live view), and two publications of one millisecond look like one
  // message.
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "first");
  const agent = core.getAgent(session.id)!;

  const contexts = agent.messages.filter((m) => m.role === "context");
  assert(contexts.length > 1, "the run must publish several contexts");
  const stamps = agent.messages.map((m) => m.timestamp);
  assert(
    stamps.every((stamp, index) => index === 0 || stamp > stamps[index - 1]!),
    `timestamps must increase along the transcript: ${stamps.join(",")}`,
  );
  // A run's tool traffic is stamped the same way: each result follows the
  // assistant message it belongs to (the transport stamps the answer when the
  // stream finalizes, which can be after the results it produced).
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "a.txt", content: "x" }, "c1"),
    ]),
    fauxAssistantMessage("done"),
  ]);
  await promptSession(core, session.id, "write");
  const all = agent.messages;
  const resultIndex = all.findIndex((m) => m.role === "toolResult");
  assert(resultIndex > 0, "the run must record its tool result");
  assert(
    all[resultIndex]!.timestamp > all[resultIndex - 1]!.timestamp,
    "a tool result must follow its assistant message in time as well",
  );

  const stamps2 = all.map((m) => m.timestamp);
  assert(
    stamps2.every((stamp, index) => index === 0 || stamp > stamps2[index - 1]!),
    `timestamps must keep increasing: ${stamps2.join(",")}`,
  );
  // The identities the clients key on are unique: role + provider for a
  // context snapshot, role + tool call id for a tool result.
  const keys = all.map((m) =>
    m.role === "context"
      ? `${m.role}:${m.provider}:${m.timestamp}`
      : m.role === "toolResult"
      ? `${m.role}:${m.toolCallId}`
      : `${m.role}:${m.timestamp}`
  );
  assertEquals(new Set(keys).size, keys.length, keys.join(" "));

  core.close();
  await removeDirRetry(root);
});

Deno.test("computer use: enabling without a host reports the machine's reason", async () => {
  const { core, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  core.setComputerHost({
    available: false,
    reason: "computer use is not supported on this platform yet (test)",
  });
  try {
    await assertRejects(
      () => core.setComputerUseEnabled(true),
      Error,
      "not supported on this platform yet",
    );
    assertEquals(
      core.isComputerUseEnabled(),
      false,
      "a refused enable stores nothing",
    );
    assertEquals(
      core.getAgent(session.id)!.agent.state.tools.some((t) =>
        t.name === TOOL_SEARCH
      ),
      true,
      "the refusal must not disturb the session",
    );
    // Disabling is always accepted: it is the safe direction.
    await core.setComputerUseEnabled(false);
    assertEquals(core.isComputerUseEnabled(), false);
  } finally {
    core.close();
  }
});

Deno.test("computer use: a recheck that finds no host keeps the startup verdict", async () => {
  const { core } = setup();
  core.setComputerHost({
    available: false,
    reason: "no display when the server started (test)",
  });
  core.setComputerHostProbe(() =>
    Promise.resolve({ available: false, reason: "still no display (test)" })
  );
  try {
    await assertRejects(
      () => core.setComputerUseEnabled(true),
      Error,
      "still no display",
    );
    assertEquals(core.isComputerUseEnabled(), false);
  } finally {
    core.close();
  }
});

Deno.test("computer use: without a probe the startup verdict stands", async () => {
  // A core built without the server (tests, an embedding) has no way to ask
  // the machine: the startup verdict must not be silently overridden.
  const { core } = setup();
  core.setComputerHost({
    available: false,
    reason: "computer use is not available on this machine (test)",
  });
  try {
    await assertRejects(
      () => core.setComputerUseEnabled(true),
      Error,
      "not available on this machine",
    );
    assertEquals(core.isComputerUseEnabled(), false);
  } finally {
    core.close();
  }
});

Deno.test("computer use: a recheck never replaces an attached host", async () => {
  // The screen-sharing session (and its restore token) belongs to the host
  // the server attached. A recheck that hands back a second host must keep
  // the first one and release the spare, or the agent's session is dropped
  // under it.
  const { core } = setup();
  const attached = new FakeComputerHost();
  const spare = new FakeComputerHost();
  core.setComputerHost({ available: true, host: attached });
  core.setComputerHostProbe(() =>
    Promise.resolve({ available: true, host: spare })
  );
  try {
    const verdict = await core.recheckComputerHost();
    assertEquals(verdict.available, true);
    assertEquals(core.getComputerHost(), attached);
  } finally {
    core.close();
  }
});

Deno.test("computer use: toggling while a session streams reaches it without a rebuild", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const host = new FakeComputerHost();
  core.setComputerHost({ available: true, host });
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    // A slow answer keeps the session streaming while the toggle is flipped:
    // the case a user hits by turning the feature on during a run.
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fauxAssistantMessage("slow");
      },
    ]);
    core.startPrompt(session.id, "go");
    while (!agent.isStreaming) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The toggle is stored and the run is left alone: the same agent, still
    // streaming. Refusing it (conflict) would make the setting unusable
    // exactly while it matters.
    await core.setComputerUseEnabled(true);
    assertEquals(core.isComputerUseEnabled(), true);
    assertEquals(core.getAgent(session.id), agent);
    assertEquals(agent.isStreaming, true);
    // The tools are seeded into the session's registry, so the run finds
    // them without one being rebuilt.
    const found = toolText(
      await agent.agent.state.tools.find((t) => t.name === TOOL_SEARCH)!
        .execute("search", { query: "computer" }, undefined),
    );
    assert(found.includes("computer_screenshot"), found);
    // The skill catalog follows on the next turn (it republishes when it
    // changed): the agent may drive the machine, so the guide is offered.
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      true,
    );
    // The session's own skill tool reads the gate per call, so the guide is
    // loadable in the run that is already going.
    const skillTool = agent.agent.state.tools.find((t) =>
      t.name === TOOL_SKILL
    )!;
    await skillTool.execute("s", { name: "computer-use" }, undefined);

    await agent.waitForIdle();

    // Disabling is the same contract in the other direction, and takes the
    // tools away from the registry the pair reads.
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fauxAssistantMessage("slow again");
      },
    ]);
    core.startPrompt(session.id, "go again");
    while (!agent.isStreaming) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await core.setComputerUseEnabled(false);
    assertEquals(core.isComputerUseEnabled(), false);
    assertEquals(core.getAgent(session.id), agent);
    const listing = toolText(
      await agent.agent.state.tools.find((t) => t.name === TOOL_SEARCH)!
        .execute("search", { query: "computer" }, undefined),
    );
    assertEquals(listing.includes("computer_screenshot"), false, listing);
    await agent.waitForIdle();
  } finally {
    core.close();
  }
});

// --- image analysis model (画像分析モデル) --------------------------------

/** A text-only main model plus a vision-capable analysis model on one
 * provider; the analysis model is selected through the model_image setting
 * (see ModelPreferencePanel in the web UI). */

Deno.test("compaction persists the checkpoint and survives a reopen", async () => {
  const { core, faux } = setup();
  registerSmallWindowModel(faux);
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: SMALL_WINDOW_MODEL_ID,
  });
  core.openSession(session.id);

  await fillHistory(core, faux, session.id, 4);
  // The next prompt needs the compaction's summarization call FIRST (the
  // pre-step runs before the request), then the turn's own answer.
  faux.setResponses([
    fauxAssistantMessage([fauxText("## Summary\n- condensed")]),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await promptSession(core, session.id, `turn 4 ${"x".repeat(20_000)}`);

  const agent = core.getAgent(session.id)!;
  // The history was condensed before the request went out. (One check may
  // make more than one pass when the retained tail is still over the
  // threshold — see MAX_COMPACTION_ATTEMPTS — so what this asserts is that
  // the transcript was condensed, not how many passes that took.)
  assertEquals(agent.messages.some((m) => m.role === "checkpoint"), true);
  const roles = agent.messages.map((m) => m.role);

  // Reopening restores the MODEL's view from the database: the newest
  // checkpoint and everything after it. The conversation before the
  // checkpoint is still there (a reader pages it out of the store) but it is
  // not loaded into memory — a conversation that runs for years holds far
  // more than any request can carry.
  await core.closeSession(session.id);
  await core.openSession(session.id);
  const restored = core.getAgent(session.id)!.messages;
  const checkpointAt = roles.findIndex((role) => role === "checkpoint");
  assertEquals(
    restored.map((m) => m.role),
    roles.slice(checkpointAt),
    "a reopen restores from the newest checkpoint, in order",
  );
  // The view starts at the checkpoint, so what the model sends begins with
  // the summary rather than the conversation's head.
  assertEquals(restored[0]!.role, "checkpoint");
  // Nothing was deleted: the terminal's earlier turns are still rows, and
  // the screen reads them from there.
  const whole = core.readTranscript(session.id, { limit: 200 })!
    .items.map((m) => m.role);
  assertEquals(whole.length > restored.length, true);
  assertEquals(whole.includes("user"), true);

  await core.close();
});

Deno.test("compactSession condenses on demand and reports the count", async () => {
  const { core, faux } = setup();
  registerSmallWindowModel(faux);
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: SMALL_WINDOW_MODEL_ID,
  });
  core.openSession(session.id);

  await fillHistory(core, faux, session.id, 3);
  const before = conversationMessages(core.getAgent(session.id)!);
  // The manual call summarizes whatever the retention budget leaves out:
  // with the default 10% kept (3K against a 30K window) the retained tail
  // would cover the whole history, so the session is tuned to keep only
  // the newest 10% — the same setting a user can change in the dialog.
  core.setSetting(COMPACTION_KEEP_RECENT_PERCENT_KEY, "10");
  // On demand: condense without waiting for the pressure threshold.
  faux.setResponses([
    fauxAssistantMessage([fauxText("## Summary\n- condensed")]),
  ]);
  const compacted = await core.compactSession(session.id, "keep the paths");
  assertEquals(compacted !== undefined && compacted > 0, true);
  const agent = core.getAgent(session.id)!;
  // Nothing was deleted: the transcript GREW by the checkpoint, which sits
  // at the cut — the summarized messages are still stored. Only the
  // conversation is counted: the head context publications (date,
  // on-demand tools) are not turn messages.
  const after = conversationMessages(agent);
  assertEquals(after.length, before.length + 1);
  const checkpointIndex = agent.messages.findIndex((m) =>
    m.role === "checkpoint"
  );
  assertEquals(checkpointIndex > 0, true);
  assertEquals(after[0]!.role, "user");
  // The model's view starts at the checkpoint, so the head publications are
  // republished after it when the checkpoint left them behind: the model
  // still reads the date it works from.
  assert(
    agent.messages.slice(checkpointIndex).some((m) =>
      m.role === "context" && m.provider === DATE_PROVIDER
    ),
    "the date must stay in the model's view after a compaction",
  );

  await core.close();
});

// --- published visuals (応答に埋め込む画像) ---------------------------------

/** Directory one session's visual assets live in (the store's layout: a
 * per-session directory beside the database). */

Deno.test("a file-backed core keeps the visuals beside its database", async () => {
  const dir = await makeRealTempDir("lumisca-visuals-core-");
  const { core } = await openFileBackedCore(dir);
  try {
    const name = "9f3c2a1b4d5e.png";
    await Deno.mkdir(visualDir(dir, "s1"), { recursive: true });
    await Deno.writeFile(join(visualDir(dir, "s1"), name), MINI_PNG);

    const found = await core.resolveSessionVisual("s1", name);
    assertEquals(found?.mimeType, "image/png");
    assertEquals(
      (await Deno.readFile(found!.path)).byteLength,
      MINI_PNG.byteLength,
    );
    // A database and its assets travel together: the root is the directory
    // of the database file, whatever path the operator chose.
    assertEquals(found!.path.startsWith(join(dir, VISUALS_DIR_NAME)), true);
    // Nothing the store would not have named is resolvable, and one
    // session's assets are not another's.
    assertEquals(
      await core.resolveSessionVisual("s1", "../lumisca.db"),
      undefined,
    );
    assertEquals(await core.resolveSessionVisual("s2", name), undefined);
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
});

Deno.test("deleting a session drops its visuals", async () => {
  const dir = await makeRealTempDir("lumisca-visuals-core-");
  const { core, sessionId } = await openFileBackedCore(dir);
  try {
    await Deno.mkdir(visualDir(dir, sessionId), { recursive: true });
    await Deno.writeFile(
      join(visualDir(dir, sessionId), "9f3c2a1b4d5e.png"),
      MINI_PNG,
    );
    await core.deleteSession(sessionId);
    // The images belonged to the conversation: nothing can reference them
    // once it is gone.
    assertEquals(
      await core.resolveSessionVisual(sessionId, "9f3c2a1b4d5e.png"),
      undefined,
    );
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
});

Deno.test("a coding session gets chat_attach and visual; a chat session neither", async () => {
  const dir = await makeRealTempDir("lumisca-visuals-core-");
  const { core, sessionId } = await openFileBackedCore(dir);
  try {
    // Both tools are preloaded in code mode: `chat_attach` hands a file
    // over as a card, `visual` puts an image inside the reply's markdown.
    // Read from the session's tool list — the prompt no longer names its
    // tools (see tools/system-prompt.ts).
    const coding = core.getAgent(sessionId)!.toolNames;
    assert(coding.includes("chat_attach"), coding.join(", "));
    assert(coding.includes("visual"), coding.join(", "));

    // A chat session has no workspace to read a file from, so it must not be
    // given either tool.
    const faux = fauxProvider();
    core.models.models.setProvider(faux.provider);
    const chat = await core.createSession({
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });
    const chatTools = core.getAgent(chat.id)!.toolNames;
    assertEquals(chatTools.includes("chat_attach"), false);
    assertEquals(chatTools.includes("visual"), false);
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
});
