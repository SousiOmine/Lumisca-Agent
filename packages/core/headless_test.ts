import { assertEquals } from "@std/assert";
import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { type ClientEvent, LumiscaCore } from "./mod.ts";
import { FAST_MODEL_KEY, serializeModelPreference } from "./shared.ts";

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
  const root = await Deno.makeTempDir({ prefix: "lumisca-headless-" });
  const ws = await core.createWorkspace(name, [root]);
  return { ws, root };
}

/** The text of every toolResult message of the transcript. */
function toolResultTexts(messages: Array<{ role: string; content?: unknown }>) {
  return messages
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const content = m.content as Array<{ type: string; text: string }>;
      return content.map((b) => b.text).join("");
    });
}

Deno.test("headless session auto-answers the ask tool with the first option", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxText("I need input."),
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

  // The run must complete without anyone answering: the ask is resolved
  // automatically (this would hang forever on a non-headless session).
  await core.prompt(session.id, "Which language should I use?");

  const messages = core.getAgent(session.id)!.messages;
  const results = toolResultTexts(messages);
  assertEquals(results.length, 1);
  assertEquals(
    results[0],
    "Answers from the user:\n- Which language?: Deno",
  );
  const last = messages.at(-1) as { content: Array<{ text: string }> };
  assertEquals(last.content[0]!.text, "Great choice!");
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("headless ask prefers the recommended option", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask", {
        questions: [{
          id: "q",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
          recommended: 1,
        }],
      }),
    ]),
    fauxAssistantMessage("ok"),
  ]);
  await core.prompt(session.id, "go");

  const results = toolResultTexts(core.getAgent(session.id)!.messages);
  assertEquals(results.length, 1);
  assertEquals(results[0], "Answers from the user:\n- Pick one: B");
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("headless session still emits the question event", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });

  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask", {
        questions: [{
          id: "q",
          question: "Pick one",
          options: [{ label: "A" }],
        }],
      }),
    ]),
    fauxAssistantMessage("ok"),
  ]);
  await core.prompt(session.id, "go");

  assertEquals(
    events.some((e) => e.type === "question" && e.sessionId === session.id),
    true,
    "the question event must still be emitted as a record",
  );
  unsubscribe();
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("non-headless sessions keep blocking asks (autoAnswer is opt-in)", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    // no headless flag
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask", {
        questions: [{
          id: "q",
          question: "Which?",
          options: [{ label: "A" }],
        }],
      }),
    ]),
    fauxAssistantMessage("ok"),
  ]);

  // The run blocks on the ask until answered (autoAnswer is off).
  const run = core.prompt(session.id, "go");
  const question = await new Promise<
    Extract<
      ClientEvent,
      { type: "question" }
    >
  >((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("question event never arrived")),
      5000,
    );
    const unsubscribe = core.subscribe((event) => {
      if (event.type === "question" && event.sessionId === session.id) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
  assertEquals(question.questions[0]!.options[0]!.label, "A");

  core.answerQuestion(session.id, question.toolCallId, [
    { id: "q", values: ["A"] },
  ]);
  await run;
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("headless session skips title generation even with a fast model", async () => {
  const faux = fauxProvider({
    models: [
      { id: "main", input: ["text"] },
      { id: "fast", input: ["text"] },
    ],
  });
  const core = LumiscaCore.forTesting([faux.provider]);
  core.setSetting(
    FAST_MODEL_KEY,
    serializeModelPreference({ provider: faux.provider.id, modelId: "fast" }),
  );
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: faux.provider.id,
    modelId: "main",
    headless: true,
  });
  assertEquals(session.name.startsWith("Session "), true);

  const captured: string[] = [];
  faux.setResponses([
    (_context: Context, _options: unknown, _state: unknown, model: {
      id: string;
    }) => {
      captured.push(model.id);
      return fauxAssistantMessage("reply");
    },
  ]);
  await core.prompt(session.id, "do the thing");

  // Only the main run: no title-generation call to the fast model.
  assertEquals(captured, ["main"]);
  assertEquals(core.getSession(session.id)!.name.startsWith("Session "), true);
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("headless system prompt mentions the auto-answered ask", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });
  const prompt = core.getAgent(session.id)!.agent.state.systemPrompt;
  assertEquals(
    prompt.includes("auto-answered with the recommended/first option"),
    true,
  );

  // A non-headless session keeps the plain guideline.
  const normal = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const normalPrompt = core.getAgent(normal.id)!.agent.state.systemPrompt;
  assertEquals(
    normalPrompt.includes("auto-answered with the recommended/first option"),
    false,
  );
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("headless session keeps auto-answering after a rebuild", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });

  // A workspace update rebuilds the open agent; the headless flag is a
  // runtime property and must survive the rebuild (otherwise the ask tool
  // would block forever with nobody to answer).
  await core.updateWorkspace(ws.id, { name: "renamed", folders: [root] });

  faux.setResponses([
    fauxAssistantMessage([
      fauxText("I need input."),
      fauxToolCall("ask", {
        questions: [{
          id: "q",
          question: "Which?",
          options: [{ label: "A" }, { label: "B" }],
        }],
      }),
    ]),
    fauxAssistantMessage("ok"),
  ]);
  // Must complete without anyone answering.
  await core.prompt(session.id, "go");

  const results = toolResultTexts(core.getAgent(session.id)!.messages);
  assertEquals(results.length, 1);
  assertEquals(results[0], "Answers from the user:\n- Which?: A");
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("a plain reopen clears the headless flag (documented behavior)", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });

  // Reopen through the normal path: the session behaves like any other
  // (the headless flag is not persisted).
  core.closeSession(session.id);
  core.openSession(session.id);

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ask", {
        questions: [{
          id: "q",
          question: "Which?",
          options: [{ label: "A" }],
        }],
      }),
    ]),
    fauxAssistantMessage("ok"),
  ]);
  const run = core.prompt(session.id, "go");
  // The ask blocks (autoAnswer is off again): answer it manually.
  const question = await new Promise<
    Extract<
      ClientEvent,
      { type: "question" }
    >
  >((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("question event never arrived")),
      5000,
    );
    const unsubscribe = core.subscribe((event) => {
      if (event.type === "question" && event.sessionId === session.id) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
  core.answerQuestion(session.id, question.toolCallId, [
    { id: "q", values: ["A"] },
  ]);
  await run;
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});

Deno.test("headless createSession without a fast model has no title call", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
    headless: true,
  });

  faux.setResponses([fauxAssistantMessage("ok")]);
  await core.prompt(session.id, "hello");
  assertEquals(core.getSession(session.id)!.name.startsWith("Session "), true);
  core.close();
  await Deno.remove(ws.folders[0]!, { recursive: true });
});
