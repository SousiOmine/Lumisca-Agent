import { basename, join } from "node:path";
import { realpathSync } from "node:fs";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { AgentMessage } from "./mod.ts";
import { LumiscaCore } from "./mod.ts";
import { VISUALS_DIR_NAME } from "./mod.ts";

import {
  makeRealTempDir,
  makeWorkspace,
  MINI_PNG,
  promptSession,
  removeDirRetry,
  setup,
} from "./test-utils.ts";

/** The instruction context messages of a session (AGENTS.md + personal). */
function instructionsMessages(agent: { messages: AgentMessage[] }) {
  return contextMessages(agent, "instructions");
}

/** The context messages (dynamic context snapshots) a session published for
 * one provider, in transcript order. */
function contextMessages(
  agent: { messages: AgentMessage[] },
  provider: string,
): Array<Extract<AgentMessage, { role: "context" }>> {
  return agent.messages.filter(
    (m): m is Extract<AgentMessage, { role: "context" }> =>
      m.role === "context" && m.provider === provider,
  );
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

/** In-memory browser backend recording opens (the unused methods are
 * never reachable in this test — the tools are only exercised through
 * browser_open). */
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

Deno.test("renaming a workspace does not touch the prompt; changing folders does", async () => {
  // The prompt is a function of the folders, not of the workspace's name:
  // re-deriving it on every open must therefore rewrite it for a folder
  // edit and leave it alone (no write, no cache break) for a rename.
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const first = core.getAgent(session.id)!.agent.state.systemPrompt;
    assert(first.includes(root), "the prompt must list the workspace folder");

    await core.updateWorkspace(ws.id, { name: "renamed" });
    assertEquals(core.getAgent(session.id)!.agent.state.systemPrompt, first);

    // The rebuild a folder edit triggers reaches the prompt, not only the
    // tools: a session opened before the edit must stop naming a folder the
    // workspace no longer has.
    await core.updateWorkspace(ws.id, { folders: [root, extra] });
    const updated = core.getAgent(session.id)!.agent.state.systemPrompt;
    assert(updated.includes(extra), updated);
    assertEquals(updated.includes(root), true);

    // The row kept what the session runs on: reopening is the same prompt.
    core.closeSession(session.id);
    await core.openSession(session.id);
    assertEquals(
      core.getAgent(session.id)!.agent.state.systemPrompt,
      updated,
    );
  } finally {
    core.close();
    await removeDirRetry(root);
    await removeDirRetry(extra);
  }
});

Deno.test("a prompt stored by an older build is replaced when the session opens", async () => {
  // The prompt is a derivation, not a frozen snapshot: a session created
  // before a release that changed the prompt must pick the new text up, or
  // it would keep running the old instructions for as long as it exists.
  // The stored value is overwritten directly, which is what an older build
  // leaves behind.
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const current = core.getAgent(session.id)!.agent.state.systemPrompt;
    core.closeSession(session.id);
    core.db.db
      .prepare("UPDATE sessions SET system_prompt = ? WHERE id = ?")
      .run("You are an assistant from an older release.", session.id);

    await core.openSession(session.id);
    const reopened = core.getAgent(session.id)!;
    assertEquals(reopened.agent.state.systemPrompt, current);
    assertEquals(
      (core.getSession(session.id) as { systemPrompt?: string }).systemPrompt,
      current,
      "the repaired prompt must be written back, not only used in memory",
    );
  } finally {
    core.close();
    await removeDirRetry(root);
  }
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
  // The machine's specs are not part of any prompt: a probe from a command
  // answers them, and the prompt is paid for on every request.
  assert(
    !prompt.includes("Environment:"),
    "no prompt carries the environment section",
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

Deno.test("deleting a workspace drops its sessions' visuals", async () => {
  const dir = await makeRealTempDir("lumisca-visuals-core-");
  const { core, workspaceId, sessionId } = await openFileBackedCore(dir);
  try {
    await Deno.mkdir(visualDir(dir, sessionId), { recursive: true });
    await Deno.writeFile(
      join(visualDir(dir, sessionId), "9f3c2a1b4d5e.png"),
      MINI_PNG,
    );
    // A workspace deletion removes its sessions; their assets must go with
    // them (the same core path, not the pool's close).
    await core.deleteWorkspace(workspaceId);
    assertEquals(
      await core.resolveSessionVisual(sessionId, "9f3c2a1b4d5e.png"),
      undefined,
    );
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
});
