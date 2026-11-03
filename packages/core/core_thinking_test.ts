import { fauxProvider } from "@lumisca/core";
import { assertEquals, assertThrows } from "@std/assert";
import { LumiscaCore } from "./mod.ts";
import { setup, makeWorkspace } from "./test-utils.ts";

/** First-block text of every transcript message (test messages are
 * text-only). Narrowed explicitly: AgentMessage also includes custom
 * messages without `content` (e.g. BashExecutionMessage). */
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
