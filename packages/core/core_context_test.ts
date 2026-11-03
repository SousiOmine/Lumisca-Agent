import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  type StreamRequest,
} from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import type { AgentMessage, ImageContent } from "./mod.ts";
import { LumiscaCore } from "./mod.ts";

import {
  FAST_MODEL_KEY,
  LANGUAGE_KEY,
  serializeModelPreference,
} from "./shared/mod.ts";

import { DATE_PROVIDER } from "./agent/date-context.ts";
import { today } from "./environment.ts";
import { bytesToBase64 } from "./base64.ts";
import { MINI_PNG, promptSession, removeDirRetry } from "./test-utils.ts";

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

/** The instruction context messages of a session (AGENTS.md + personal). */
function instructionsMessages(agent: { messages: AgentMessage[] }) {
  return contextMessages(agent, "instructions");
}

/** The conversation of a session: every message the session and the model
 * exchanged, without the dynamic-context publications (skill catalog,
 * instructions, date, on-demand tools). Those are prepended before the
 * first user message of a run and are not part of a turn, so a test that
 * counts or positions turns must count this array. */

/** The conversation of a session: every message the session and the model
 * exchanged, without the dynamic-context publications (skill catalog,
 * instructions, date, on-demand tools). Those are prepended before the
 * first user message of a run and are not part of a turn, so a test that
 * counts or positions turns must count this array. */
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

/** A model whose window is small enough that a few turns of history cross
 * the pressure threshold; the completion reserve is part of the budget the
 * provider validates against (`window - outputCap`). */
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
