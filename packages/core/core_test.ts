import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type StreamRequest,
} from "@lumisca/core";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  AgentMessage,
  BrowserBackend,
  ClientEvent,
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  ImageContent,
  RawCapture,
  Rect,
} from "./mod.ts";
import { CoreError, LumiscaCore } from "./mod.ts";
import { LumiscaDb } from "./mod.ts";
import { COMPACTION_KEEP_RECENT_TOKENS_KEY } from "./shared/settings-keys.ts";
import { SCHEMA_VERSION } from "./db/schema.ts";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  LANGUAGE_KEY,
  serializeModelPreference,
  TOOL_BROWSER_OPEN,
  TOOL_CALL,
  TOOL_COMPUTER_SCREENSHOT,
  TOOL_PDF_READ_PAGES,
  TOOL_SEARCH,
} from "./shared/mod.ts";
import { MCP_TOOLS_PROVIDER, ON_DEMAND_TOOLS_NOTE } from "./mcp/context.ts";
import { DATE_PROVIDER } from "./agent/date-context.ts";
import { today } from "./environment.ts";
import { bytesToBase64 } from "./base64.ts";
import {
  makeRealTempDir,
  MINI_PNG,
  promptSession,
  removeDirRetry,
} from "./test-utils.ts";

function setup(env?: () => Record<string, string>) {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider], env);
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

/** The context messages (dynamic context snapshots) a session published
 * for one provider, in transcript order. */
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
function instructionsMessages(agent: { messages: AgentMessage[] }) {
  return contextMessages(agent, "instructions");
}

/** The conversation of a session: every message the session and the model
 * exchanged, without the dynamic-context publications (skill catalog,
 * instructions, date, on-demand tools). Those are prepended before the
 * first user message of a run and are not part of a turn, so a test that
 * counts or positions turns must count this array. */
function conversationMessages(
  agent: { messages: AgentMessage[] },
): AgentMessage[] {
  return agent.messages.filter((m) => m.role !== "context");
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
  await removeDirRetry(root);
});

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

Deno.test("tools block file access outside the workspace", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const outside = await Deno.makeTempDir({ prefix: "lumisca-outside-" });
  await Deno.writeTextFile(join(outside, "secret.txt"), "secret");

  const session = await core.createSession({
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
  await promptSession(core, session.id, "Read that file");

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
  await promptSession(core, session.id, "Read inside.txt");
  const messages2 = core.getAgent(session.id)!.messages;
  const tr2 = messages2.filter((m) => m.role === "toolResult").at(-1) as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assertEquals(tr2.isError, false);
  assertEquals(tr2.content[0]!.text.includes("hello"), true);

  core.close();
  await removeDirRetry(root);
  await removeDirRetry(outside);
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
  // Default-model resolution only considers providers configured inside
  // Lumisca; a stored key is what makes the faux provider one.
  await core.setProviderApiKey(providerId, "faux-key");

  const first = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  assertEquals(first.modelProvider, providerId);
  assertEquals(first.modelId, modelId);

  // Second session without explicit model: inherits the last used one.
  const second = await core.createSession({ workspaceId: ws.id });
  assertEquals(second.modelProvider, providerId);
  assertEquals(second.modelId, modelId);

  core.close();
});

Deno.test("getDefaultModel returns the last used model or a fallback", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  await core.setProviderApiKey(providerId, "faux-key");

  // No sessions yet: the configured provider's first enabled model.
  const initial = await core.getDefaultModel();
  assertEquals(initial?.provider, providerId);
  assertEquals(initial?.modelId, modelId);
  assertEquals(core.isModelEnabled(initial!.provider, initial!.modelId), true);

  // After a session: the last used model wins.
  await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const last = await core.getDefaultModel();
  assertEquals(last, {
    provider: providerId,
    modelId,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  });

  core.close();
});

Deno.test("session without model falls back to a configured provider", async () => {
  const { core, faux } = setup();
  const { ws } = await makeWorkspace(core);
  await core.setProviderApiKey(faux.provider.id, "faux-key");

  // With no prior sessions, the configured provider's first enabled model
  // is used: the built-in catalog entries registered before the faux
  // provider carry no credentials and are skipped.
  const session = await core.createSession({ workspaceId: ws.id });
  assertEquals(session.modelProvider, faux.provider.id);
  assertEquals(session.modelId, faux.getModel().id);

  // The faux provider is still usable when selected explicitly.
  const explicit = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  assertEquals(explicit.modelProvider, faux.provider.id);

  core.close();
});

Deno.test("no configured provider: no default model and no session", async () => {
  const { core } = setup();
  const { ws } = await makeWorkspace(core);

  // The built-in providers are registered — with their models enabled —
  // just from the catalog, but none of them is configured: there is
  // nothing to default to, so the draft stays without a model instead of
  // auto-selecting an entry that could not stream.
  assertEquals(await core.getDefaultModel(), null);

  // Creating a session without a model fails instead of guessing; the
  // route surfaces it as 503 ("unavailable").
  const error = await assertRejects(
    async () => await core.createSession({ workspaceId: ws.id }),
    CoreError,
  );
  assertEquals(error.kind, "unavailable");

  // An explicit model is still accepted: API callers may create the
  // session first and configure the provider afterwards.
  const explicit = await core.createSession({
    workspaceId: ws.id,
    modelProvider: "openai",
    modelId: core.listModels("openai")[0]!.id,
  });
  assertEquals(explicit.modelProvider, "openai");

  core.close();
});

Deno.test("workspace update rebuilds session tools", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });

  await core.createSession({
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
  await removeDirRetry(root);
  await removeDirRetry(extra);
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

Deno.test("mode prompt keeps the images attached in the composer", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  // Capture what the model is asked: the messages of the run's request.
  let sent: StreamRequest["messages"] | undefined;
  faux.setResponses([
    (context: StreamRequest) => {
      sent = context.messages;
      return fauxAssistantMessage("plan reply");
    },
  ]);

  // The web path (startPrompt) with a mode and a pasted image: plan mode
  // entered on the draft composer (`/plan 依頼文`) after attaching a
  // screenshot. Attaching images to a mode prompt must work exactly like
  // attaching them to a plain message.
  const image: ImageContent = {
    type: "image",
    data: bytesToBase64(MINI_PNG),
    mimeType: "image/png",
  };
  const fullPrompt = "あなたは実装プランナーです。履歴機能を追加して";
  core.startPrompt(session.id, fullPrompt, [image], {
    modeId: "plan",
    optionId: "",
    modeLabel: "プランモード",
    shortText: "履歴機能を追加して",
  });
  await core.getAgent(session.id)!.waitForIdle();

  // The transcript stores the image on the mode message (the UI renders it
  // in the bubble; the rewind action restores it to the composer).
  const modeMessage = core.getAgent(session.id)!.messages.find(
    (m): m is Extract<AgentMessage, { role: "mode" }> => m.role === "mode",
  )!;
  assertEquals(modeMessage.images, [image]);

  // The model receives the full prompt text together with the image.
  const prompt = sent!.filter((m) => m.role === "user").at(-1)!;
  assert(Array.isArray(prompt.content));
  assertEquals(
    prompt.content.some((b) => b.type === "text" && b.text === fullPrompt),
    true,
  );
  assertEquals(prompt.content.some((b) => b.type === "image"), true);
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

Deno.test("model switch and workspace update are refused while streaming", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });

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
  await removeDirRetry(root);
  await removeDirRetry(extra);
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
  // The ambient environment is the test's own object, not the process's:
  // an env key must resolve for requests while the provider still counts
  // as unconfigured inside Lumisca.
  const ambient: Record<string, string> = {};
  const { core } = setup(() => ambient);
  try {
    assertEquals(await core.hasProviderAuth("anthropic"), false);
    assertEquals(await core.hasConfiguredAuth("anthropic"), false);

    // An env key set for other tools resolves for actual requests ...
    ambient.ANTHROPIC_API_KEY = "sk-env-only";
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

Deno.test("chat session: created without a workspace, chat prompt, no file tools", async () => {
  const { core, faux, providerId, modelId } = setup();

  // No workspaceId → a chat session in the folder-less chat workspace.
  const session = await core.createSession({
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
  const second = await core.createSession({
    modelProvider: providerId,
    modelId,
  });
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
  await promptSession(core, session.id, "Hi");
  const messages = conversationMessages(core.getAgent(session.id)!);
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
  assertEquals(conversationMessages(reopenedAgent).length, 2);

  core.close();
});

Deno.test("session language: the prompt is generated with the setting, then frozen", async () => {
  const { core, providerId, modelId } = setup();
  try {
    // The language is a server setting (the settings dialog writes exactly
    // this), read when the session's prompt is generated.
    core.setSetting(LANGUAGE_KEY, "en");
    const english = await core.createSession({
      modelProvider: providerId,
      modelId,
    });
    const englishPrompt = core.getAgent(english.id)!.agent.state.systemPrompt;
    assert(
      englishPrompt.includes("Write every reply in English"),
      "an English session must be told to answer in English",
    );
    // The provisional session name follows the same language.
    assert(
      english.name.startsWith("Session "),
      `english session name: ${english.name}`,
    );

    // Changing the setting afterwards does not touch an existing session:
    // its prompt is the snapshot taken at creation, so the agent keeps
    // answering in the language the session started in.
    core.setSetting(LANGUAGE_KEY, "ja");
    core.closeSession(english.id);
    await core.openSession(english.id);
    assertEquals(
      core.getAgent(english.id)!.agent.state.systemPrompt,
      englishPrompt,
    );

    // A session created after the switch starts in the new language.
    const japanese = await core.createSession({
      modelProvider: providerId,
      modelId,
    });
    const japanesePrompt = core.getAgent(japanese.id)!.agent.state.systemPrompt;
    assert(
      japanesePrompt.includes("Write every reply in Japanese"),
      "a Japanese session must be told to answer in Japanese",
    );
    assert(
      japanese.name.startsWith("セッション "),
      `japanese session name: ${japanese.name}`,
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

Deno.test("chat workspace cannot be updated or deleted", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const session = await core.createSession({
    modelProvider: providerId,
    modelId,
  });
  const chatWorkspace = core.getWorkspace(session.workspaceId)!;
  assertEquals(chatWorkspace.chat, true);

  await assertRejects(
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

  const session = await core.createSession({
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
  const s2 = await plain.core.createSession({
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

  const session = await core.createSession({
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

  const session = await core.createSession({
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
  const session = await core.createSession({
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
  await promptSession(core, session.id, "hi");
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
  await promptSession(core, session.id, "again");
  assertEquals(receivedReasoning, undefined);

  core.close();
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

Deno.test("workspace instructions are context messages, not prompt text, and edits reach an open session", async () => {
  const { core, faux, providerId, modelId } = setup();
  const root = await Deno.makeTempDir({ prefix: "lumisca-core-" });
  await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 2.\n");
  const ws = await core.createWorkspace("ws", [root]);

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const agent = core.getAgent(session.id)!;
  const prompt = agent.agent.state.systemPrompt;
  assertEquals(
    prompt.includes("Use Deno 2."),
    false,
    "AGENTS.md must not be baked into the prompt",
  );
  assertEquals(prompt.includes("Project memory"), false);

  // The first run publishes the instruction baseline as a context message,
  // before the user message it belongs to.
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "first");
  const published = instructionsMessages(agent);
  assertEquals(published.length, 1);
  assert(
    published[0]!.body.includes("Use Deno 2."),
    `baseline must carry the file: ${published[0]!.body}`,
  );
  assert(published[0]!.title.startsWith("Workspace instructions"));
  const firstUser = agent.messages.findIndex((m) => m.role === "user");
  assert(
    agent.messages.findIndex((m) => m.role === "context") < firstUser,
    "the context message must precede the run's user message",
  );

  // An edit reaches the open session: the next run publishes only the change.
  await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno 3.\n");
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "second");
  const updated = instructionsMessages(agent);
  assertEquals(updated.length, 2);
  assert(
    updated[1]!.body.includes("Use Deno 3."),
    `the update must carry the new content: ${updated[1]!.body}`,
  );
  assert(updated[1]!.title.startsWith("Instructions updated"));
  assertEquals(
    agent.agent.state.systemPrompt,
    prompt,
    "the instructions never touch the prompt snapshot",
  );

  // Reopening keeps the stored prompt and does not republish an unchanged
  // instruction file.
  core.closeSession(session.id);
  await core.openSession(session.id);
  const reopened = core.getAgent(session.id)!;
  assertEquals(reopened.agent.state.systemPrompt, prompt);
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "third");
  assertEquals(
    instructionsMessages(reopened).length,
    2,
    "an unchanged instruction file must not be republished on reopen",
  );

  // A session created after the edit starts from the current content.
  const fresh = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const freshAgent = core.getAgent(fresh.id)!;
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, fresh.id, "hello");
  const freshBaseline = instructionsMessages(freshAgent);
  assertEquals(freshBaseline.length, 1);
  assert(
    freshBaseline[0]!.body.includes("Use Deno 3."),
    "new sessions must read the current AGENTS.md",
  );

  core.close();
  await removeDirRetry(root);
});

Deno.test("personalization (machine AGENTS.md) is published with the workspace instructions", async () => {
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

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  const agent = core.getAgent(session.id)!;
  const prompt = agent.agent.state.systemPrompt;
  assertEquals(
    prompt.includes("Workspace memory."),
    false,
    "workspace instructions are dynamic context, not prompt text",
  );
  assertEquals(prompt.includes("Answer in Japanese."), false);

  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "first");
  const baseline = instructionsMessages(agent);
  assertEquals(baseline.length, 1, "one baseline covers both files");
  assert(baseline[0]!.body.includes("Workspace memory."));
  assert(
    baseline[0]!.body.includes("Answer in Japanese."),
    "the personal file rides along with the workspace instructions",
  );
  assertEquals(
    baseline[0]!.body.indexOf("Answer in Japanese.") >
      baseline[0]!.body.indexOf("Workspace memory."),
    true,
    "personalization must follow project memory",
  );

  // An edit to the personal file reaches the open session...
  await Deno.writeTextFile(agentFile, "Answer in English.\n");
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "second");
  const updated = instructionsMessages(agent);
  assertEquals(updated.length, 2);
  assert(updated[1]!.body.includes("Answer in English."));

  // ...and a new session starts from the current content.
  const fresh = await core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: faux.getModel().id,
  });
  const freshAgent = core.getAgent(fresh.id)!;
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, fresh.id, "hello");
  const freshBaseline = instructionsMessages(freshAgent);
  assertEquals(freshBaseline.length, 1);
  assert(
    freshBaseline[0]!.body.includes("Answer in English."),
    "new sessions must read the current personalization",
  );

  // setPersonalization writes the file.
  core.setPersonalization("New instructions.\n");
  assertEquals(Deno.readTextFileSync(agentFile), "New instructions.\n");

  core.close();
  await removeDirRetry(dir);
  await removeDirRetry(root);
});

Deno.test("the date is published once as a context message, not rewritten into the prompt", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const agent = core.getAgent(session.id)!;

  // The prompt is a creation-time snapshot, so a fact that changes while
  // the session lives (the date) must not be baked into it.
  assertEquals(
    agent.agent.state.systemPrompt.includes("Date:"),
    false,
    "the date must stay out of the prompt snapshot",
  );
  assertEquals(
    agent.messages.length,
    0,
    "nothing is published before the first run",
  );

  // The first run publishes the date once, before its own user message.
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "first");
  const published = contextMessages(agent, DATE_PROVIDER);
  assertEquals(published.length, 1, "the date is published exactly once");
  assertEquals(published[0]!.title, `Date: ${today()}`);
  assertEquals(
    published[0]!.body,
    `The current date is ${today()}.`,
    "the model-facing body carries the reading",
  );
  assert(
    agent.messages.indexOf(published[0]!) <
      agent.messages.findIndex((m) => m.role === "user"),
    "the date must precede the run's user message",
  );

  // Another run on the same day does not republish it...
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "second");
  assertEquals(contextMessages(agent, DATE_PROVIDER).length, 1);

  // ...and neither does reopening the session: the publication is still in
  // the history the model reads, so the provider has nothing to add — and
  // the prompt snapshot is untouched.
  core.closeSession(session.id);
  await core.openSession(session.id);
  const reopened = core.getAgent(session.id)!;
  const prompt = agent.agent.state.systemPrompt;
  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "third");
  assertEquals(contextMessages(reopened, DATE_PROVIDER).length, 1);
  assertEquals(reopened.agent.state.systemPrompt, prompt);

  core.close();
  await removeDirRetry(root);
});

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
    const session = await core.createSession({
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
    // attached and the on-demand-tools note is published as context.
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        agent.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "search/call pair must be attached for the browser tools",
    );
    // The built-in web-browser skill is advertised in the session's skill
    // catalog (a context message published before the first run), not in
    // the system prompt.
    assertEquals(
      agent.agent.state.systemPrompt.includes("web-browser"),
      false,
      "the prompt must stay free of per-session skill data",
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
    await promptSession(core, session.id, "Open the app in the browser");

    // The on-demand-tools note is published by that run as a context
    // message, before its user message — never appended to the prompt.
    const running = core.getAgent(session.id)!;
    const notes = contextMessages(running, MCP_TOOLS_PROVIDER);
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(notes[0]!.body, ON_DEMAND_TOOLS_NOTE);
    assert(
      running.messages.indexOf(notes[0]!) <
        running.messages.findIndex((m) => m.role === "user"),
      "the note must precede the run's user message",
    );
    assertEquals(
      running.agent.state.systemPrompt.includes("tool_search"),
      false,
      "the prompt must stay free of the on-demand-tools note",
    );

    // The skill catalog went in before the user message and lists the
    // built-in browser skill.
    const catalog = core.getAgent(session.id)!.messages.find(
      (m) => m.role === "context" && m.provider === "skills",
    );
    assert(
      catalog !== undefined && catalog.role === "context",
      "expected a skill catalog message",
    );
    assert(
      catalog.body.includes("- web-browser:"),
      "the built-in web-browser skill must be listed with a backend attached",
    );

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

Deno.test("pdf tool is seeded into the session registry via tool_search", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  try {
    // No browser backend, no MCP servers: the PDF page-as-image tool is
    // still seeded by the pool at open.
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_PDF_READ_PAGES),
      false,
      "the pdf tool must stay out of the agent tool set",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        agent.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "search/call pair must be attached for the pdf tool",
    );

    // The model finds it through tool_search.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "pdf" }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "What PDF tools exist?");

    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 1);
    const tr = toolResults[0] as {
      content: Array<{ type: string; text: string }>;
    };
    assert(
      tr.content[0]!.text.includes(TOOL_PDF_READ_PAGES),
      `pdf tool not discoverable: ${tr.content[0]!.text}`,
    );
  } finally {
    core.close();
  }
});

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

/** In-memory computer host: serves one tiny display and records what the
 * tools asked it to do (the unused methods are never reachable here). */
class FakeComputerHost implements ComputerHost {
  readonly captures: Rect[] = [];
  readonly actions: ComputerAction[] = [];

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
  cursor() {
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

Deno.test("computer use: the tools are seeded via tool_search only when enabled", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const host = new FakeComputerHost();
  core.setComputerHost({ available: true, host });
  try {
    // Disabled by default: nothing seeded, no skill advertised.
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const disabled = core.getAgent(session.id)!;
    assertEquals(
      disabled.agent.state.tools.some((t) => t.name.startsWith("computer_")),
      false,
      "definitions must never be preloaded",
    );
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      false,
      "the skill must not be advertised while the feature is off",
    );
    assertEquals(core.isComputerUseEnabled(), false);

    // Enabling applies to the open session immediately (the pool rebuilds
    // it) and its registry now holds the family.
    core.setComputerUseEnabled(true);
    const enabled = core.getAgent(session.id)!;
    assert(enabled !== disabled, "enabling must rebuild the open agent");
    assertEquals(core.isComputerUseEnabled(), true);
    assertEquals(
      enabled.agent.state.tools.some((t) => t.name.startsWith("computer_")),
      false,
      "the family stays out of the preloaded tool set",
    );
    assertEquals(
      enabled.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        enabled.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "the search/call pair must be attached for the computer tools",
    );
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      true,
      "the built-in skill must be advertised once the feature is on",
    );

    // The model finds the tool through tool_search and drives the host
    // through tool_call.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "computer" }),
      ]),
      fauxAssistantMessage([
        fauxText("Capturing."),
        fauxToolCall(TOOL_CALL, {
          name: TOOL_COMPUTER_SCREENSHOT,
          args: {},
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "Look at the screen");

    // The run published the on-demand-tools note as a context message,
    // ahead of its user message — the prompt stays free of it.
    const notes = contextMessages(
      core.getAgent(session.id)!,
      MCP_TOOLS_PROVIDER,
    );
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(notes[0]!.body, ON_DEMAND_TOOLS_NOTE);
    assertEquals(
      core.getAgent(session.id)!.agent.state.systemPrompt.includes(
        "tool_search",
      ),
      false,
      "the prompt must stay free of the on-demand-tools note",
    );

    assertEquals(host.captures, [{ x: 0, y: 0, width: 256, height: 144 }]);
    const toolResults = core.getAgent(session.id)!.messages.filter(
      (m) => m.role === "toolResult",
    );
    assertEquals(toolResults.length, 2);
    const tr = toolResults[1] as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.isError, false, `tool call failed: ${tr.content[0]?.text}`);
    assert(
      tr.content[0]!.text.includes("image 256×144"),
      `unexpected screenshot result: ${tr.content[0]!.text}`,
    );
    // The skill catalog published before the run lists the built-in skill.
    const catalog = core.getAgent(session.id)!.messages.find(
      (m) => m.role === "context" && m.provider === "skills",
    );
    assert(
      catalog !== undefined && catalog.role === "context" &&
        catalog.body.includes("- computer-use:"),
      "the built-in computer-use skill must be listed while enabled",
    );

    // Disabling removes the family from the registry again (the rebuild),
    // while the PDF tool keeps the search/call pair attached.
    core.setComputerUseEnabled(false);
    const off = core.getAgent(session.id)!;
    assertEquals(core.isComputerUseEnabled(), false);
    assertEquals(
      off.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      true,
      "the PDF tool keeps the search/call pair attached",
    );
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      false,
      "the skill disappears with the capability",
    );
  } finally {
    core.close();
  }
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
    assertThrows(
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
    core.setComputerUseEnabled(false);
    assertEquals(core.isComputerUseEnabled(), false);
  } finally {
    core.close();
  }
});

Deno.test("computer use: toggling while a session streams is refused", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  core.setComputerHost({ available: true, host: new FakeComputerHost() });
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return fauxAssistantMessage("slow");
      },
    ]);
    core.startPrompt(session.id, "go");
    assertThrows(
      () => core.setComputerUseEnabled(true),
      Error,
      "already running",
    );
    await core.getAgent(session.id)!.waitForIdle();
    // The refused toggle stored nothing.
    assertEquals(core.isComputerUseEnabled(), false);
  } finally {
    core.close();
  }
});

// --- image analysis model (画像分析モデル) --------------------------------

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
      StreamRequest: StreamRequest,
      _options: unknown,
      _state: unknown,
      model: { id: string },
    ) => {
      const call: CapturedCall = {
        model: model.id,
        systemPrompt: StreamRequest.systemPrompt,
        messages: StreamRequest.messages as CapturedCall["messages"],
      };
      captured.push(call);
      return step(call);
    },
  );
}

Deno.test("text-only model: user images are analyzed and passed as text", async () => {
  const { core, faux, providerId } = setupImageAnalysis();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "text-only",
  });

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    () => fauxAssistantMessage("analysis text"),
    () => fauxAssistantMessage("done"),
  ]));

  await promptSession(core, session.id, "what is this?", [{
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
  // The run's context publications (date, on-demand tools) reach the
  // provider as user-role messages of their own (see toLlmMessages), so
  // the actual prompt is the newest user message of the request.
  assertEquals(captured[1]!.model, "text-only");
  const mainUser = captured[1]!.messages.filter((m) => m.role === "user")
    .at(-1)!;
  const mainContent = mainUser.content;
  assertEquals(mainContent.some((b) => b.type === "image"), false);
  assertEquals(
    mainContent.some(
      (b) => b.type === "text" && b.text?.includes("analysis text"),
    ),
    true,
  );
  // The transcript (what the UI shows and the DB stores) keeps the image.
  const userMessage = core.getAgent(session.id)!.messages.find((m) =>
    m.role === "user"
  )!;
  const userContent = (userMessage as { content: Array<{ type: string }> })
    .content;
  assertEquals(userContent.some((b) => b.type === "image"), true);
  core.close();
});

Deno.test("text-only model: read tool images are analyzed and passed as text", async () => {
  const { core, faux, providerId } = setupImageAnalysis();
  const { ws, root } = await makeWorkspace(core);
  await Deno.writeFile(join(root, "pic.png"), MINI_PNG);

  const session = await core.createSession({
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

  await promptSession(core, session.id, "read pic.png");

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

  // The provisional name follows the app language, so the test pins it
  // instead of depending on the machine's locale.
  core.setSetting(LANGUAGE_KEY, "ja");
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "main",
  });
  assertEquals(session.name.startsWith("セッション "), true); // provisional

  const captured: CapturedCall[] = [];
  faux.setResponses(makeImageAnalysisResponses(captured, [
    // The title call (fast model) fires concurrently with the run.
    () => fauxAssistantMessage('"Fix login bug"'),
    () => fauxAssistantMessage("Hello!"),
  ]));

  await promptSession(core, session.id, "Please fix the login bug");

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

  // Pinned like the test above: the provisional name is localized.
  core.setSetting(LANGUAGE_KEY, "ja");
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: "main",
  });
  assertEquals(session.name.startsWith("セッション "), true); // provisional

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

  // Pinned: the provisional name is the localized "Session <date>".
  core.setSetting(LANGUAGE_KEY, "ja");
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId: faux.getModel().id,
  });

  faux.setResponses([fauxAssistantMessage("ok")]);
  await promptSession(core, session.id, "hello");

  assertEquals(core.getSession(session.id)!.name, session.name);
  assertEquals(session.name.startsWith("セッション "), true);

  core.close();
});

Deno.test("reopened session with history does not regenerate the title", async () => {
  const { core, faux, providerId } = setupFastTitle();
  const { ws } = await makeWorkspace(core);

  const session = await core.createSession({
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

  await promptSession(core, session.id, "first message");
  assertEquals(core.getSession(session.id)!.name, "Title A");

  // Reopen with history and prompt again: no new title generation.
  core.closeSession(session.id);
  await core.openSession(session.id);
  await promptSession(core, session.id, "second message");

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
  const session = await core.createSession({
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
  const run = promptSession(core, session.id, "Which language should I use?");
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

Deno.test("todo tool records the whole plan and replaces it on the next call", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("todo", {
        phases: [{
          name: "実装",
          tasks: [{ name: "調査する" }, { name: "実装する" }, {
            name: "テストする",
          }],
        }],
      }),
    ]),
    fauxAssistantMessage([
      fauxToolCall("todo", {
        phases: [{
          name: "実装",
          tasks: [
            { name: "調査する", status: "completed" },
            { name: "実装する", status: "in_progress" },
            { name: "テストする" },
          ],
        }],
      }),
    ]),
    fauxAssistantMessage("finished!"),
  ]);

  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  await promptSession(core, session.id, "Plan and track the work");

  // Every call emitted a `todo` snapshot event for this session.
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
  // The second call sent the whole plan again, with the new statuses.
  const updated = todoEvents.at(-1)!.todos[0]!.tasks.map((t) => [
    t.name,
    t.status,
  ]);
  assertEquals(updated, [
    ["調査する", "completed"],
    ["実装する", "in_progress"],
    ["テストする", "pending"],
  ]);

  // The results report the counts back to the agent.
  const messages = core.getAgent(session.id)!.messages;
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 2);
  const firstResult = (toolResults[0] as { content: Array<{ text: string }> })
    .content[0]!.text;
  assertEquals(firstResult, "Updated todo list: 3 pending.");
  const last = messages.at(-1) as { content: Array<{ text: string }> };
  assertEquals(last.content[0]!.text, "finished!");

  unsubscribe();
  core.close();
});

Deno.test("rewind while a question is pending aborts the run cleanly", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
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

  const run = promptSession(core, session.id, "Which language should I use?");
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

// ---- context compaction (see agent/context-compaction.ts) ------------------

/** A model whose window is small enough that a few turns of history cross
 * the pressure threshold; the completion reserve is part of the budget the
 * provider validates against (`window - outputCap`). */
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
  // The history was condensed before the request went out.
  assertEquals(agent.messages.some((m) => m.role === "checkpoint"), true);
  const roles = agent.messages.map((m) => m.role);

  // Reopening restores exactly the condensed transcript from the database:
  // the checkpoint row is where the insert put it, every message around it
  // survived, and nothing is duplicated or resurrected.
  await core.closeSession(session.id);
  await core.openSession(session.id);
  const restored = core.getAgent(session.id)!.messages;
  assertEquals(restored.map((m) => m.role), roles);
  const checkpointIndex = roles.findIndex((role) => role === "checkpoint");
  assertEquals(checkpointIndex > 0, true);
  // The conversation still starts with the user's first message; the head
  // of the transcript is the run's dynamic context (date, on-demand
  // tools), which belongs to no turn.
  assertEquals(conversationMessages({ messages: restored })[0]!.role, "user");
  assertEquals(
    restored[0]!.role,
    "context",
    "the transcript head is a context publication",
  );

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
  // with the default 20K kept (against a 30K window) the retained tail
  // would cover the whole history, so the session is tuned to keep only
  // the newest 1K — the same settings a user can change in the dialog.
  core.setSetting(COMPACTION_KEEP_RECENT_TOKENS_KEY, "1000");
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
