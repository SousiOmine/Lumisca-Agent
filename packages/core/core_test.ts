import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { assertEquals, assertRejects } from "@std/assert";
import { LumiscaCore } from "./mod.ts";

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
  const models = core.listModelsWithState(providerId);
  assertEquals(models.length > 0, true);
  const target = models[0]!;

  // Default: enabled.
  assertEquals(core.isModelEnabled(providerId, target.id), true);

  // Disable: persisted.
  core.setModelEnabled(providerId, target.id, false);
  assertEquals(core.isModelEnabled(providerId, target.id), false);
  const after = core.listModelsWithState(providerId);
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
  assertEquals(core.getDefaultModel(), { provider: providerId, modelId });

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

Deno.test("workspace folder update rebuilds session tools", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });

  core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  await core.updateWorkspaceFolders(ws.id, [root, extra]);

  const updated = core.getWorkspace(ws.id);
  assertEquals(updated !== undefined, true);
  assertEquals(updated!.folders.length, 2);

  core.close();
  await Deno.remove(root, { recursive: true });
  await Deno.remove(extra, { recursive: true });
});
