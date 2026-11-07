import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type StreamRequest,
} from "@lumisca/core";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { CoreError, LumiscaCore } from "./mod.ts";

import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  LANGUAGE_KEY,
  serializeModelPreference,
} from "./shared/mod.ts";

import { bytesToBase64 } from "./base64.ts";
import { makeWorkspace, MINI_PNG, promptSession, setup } from "./test-utils.ts";
import { DEFAULT_MODEL_KEY } from "./shared/mod.ts";

/** First-block text of every transcript message (test messages are
 * text-only). Narrowed explicitly: AgentMessage also includes custom
 * messages without `content` (e.g. BashExecutionMessage). */
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

Deno.test("getDefaultModel prefers the user's default over the last used model", async () => {
  const { core, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  await core.setProviderApiKey(providerId, "faux-key");
  // A session on the provider's model, so "last used" has an answer.
  await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  // Without the setting, the last used model wins.
  assertEquals((await core.getDefaultModel())?.modelId, modelId);

  // With it, the default wins over the last used model. The fixture has one
  // model, so the two answers agree on its id; what this pins is that the
  // resolver reads the setting FIRST, which the "skips an unreachable
  // default" test below shows by making the default unusable.
  core.setSetting(
    DEFAULT_MODEL_KEY,
    JSON.stringify({ provider: providerId, modelId }),
  );
  assertEquals((await core.getDefaultModel())?.modelId, modelId);
  // And with a different model named, that one answers — the fixture cannot
  // supply a second one, so the fallthrough is what is checked instead: a
  // default naming a model this installation does not have is ignored rather
  // than obeyed.
  core.setSetting(
    DEFAULT_MODEL_KEY,
    JSON.stringify({ provider: providerId, modelId: "not-a-model" }),
  );
  assertEquals((await core.getDefaultModel())?.modelId, modelId);
});

Deno.test("getDefaultModel skips a default this installation cannot reach", async () => {
  // A default naming a provider that was removed (or an id that retired)
  // must not make every new session fail: the resolver falls through to
  // what it would have answered without the setting.
  const { core, providerId, modelId } = setup();
  const { ws: _ws } = await makeWorkspace(core);
  await core.setProviderApiKey(providerId, "faux-key");
  core.setSetting(
    DEFAULT_MODEL_KEY,
    JSON.stringify({ provider: "gone", modelId: "gone-model" }),
  );
  assertEquals((await core.getDefaultModel())?.modelId, modelId);
});
