import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { LumiscaCore } from "@lumisca/core";
import { handleCommand, runRepl } from "./repl.ts";
import { setPromptFn } from "./ui.ts";

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

/** Feed the given prompts in order; anything beyond the list returns null. */
function withPrompts(sequence: Array<string | null>): void {
  let i = 0;
  setPromptFn(() => sequence[i++] ?? null);
}

async function makeSession(
  core: LumiscaCore,
  providerId: string,
  modelId: string,
) {
  const ws = await core.createWorkspace("test-ws", [Deno.cwd()]);
  const session = core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  return { ws, session };
}

Deno.test("handleCommand /name renames the current session", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  const result = await handleCommand(core, "/name my-session", session.id);
  assertEquals(result, undefined);
  assertEquals(core.getSession(session.id)?.name, "my-session");
  core.close();
});

Deno.test("handleCommand /exit and /quit end the repl", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  assertEquals(await handleCommand(core, "/exit", session.id), "exit");
  assertEquals(await handleCommand(core, "/quit", session.id), "exit");
  assertEquals(await handleCommand(core, "/q", session.id), "exit");
  core.close();
});

Deno.test("handleCommand /new creates a session in the current workspace", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, session } = await makeSession(core, providerId, modelId);

  // pickModel: search + select the faux provider, then its model.
  withPrompts([faux.provider.id, "1", faux.getModel().id, "1"]);
  const next = await handleCommand(core, "/new", session.id);
  assertEquals(typeof next, "string");
  assertEquals(core.getSession(next!)?.workspaceId, ws.id);
  core.close();
});

Deno.test("handleCommand /model switches the session model", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  withPrompts([faux.provider.id, "1", faux.getModel().id, "1"]);
  const result = await handleCommand(core, "/model", session.id);
  assertEquals(result, undefined);
  assertEquals(core.getSession(session.id)?.modelProvider, providerId);
  assertEquals(core.getSession(session.id)?.modelId, modelId);
  core.close();
});

Deno.test("handleCommand /keys stores the API key", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  withPrompts(["anthropic", "sk-test-123"]);
  const result = await handleCommand(core, "/keys", session.id);
  assertEquals(result, undefined);

  // The stored key resolves through the public, network-free auth check
  // (behavioral assertion — no reaching into the storage format).
  assertEquals(await core.hasProviderAuth("anthropic"), true);
  core.close();
});

Deno.test("handleCommand /resume opens the selected session", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  withPrompts(["1"]);
  const next = await handleCommand(core, "/resume", session.id);
  assertEquals(next, session.id);
  core.close();
});

Deno.test("handleCommand rejects unknown commands", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  assertEquals(await handleCommand(core, "/bogus", session.id), undefined);
  core.close();
});

Deno.test("runRepl re-subscribes after /new so tool output still renders", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);
  await core.openSession(session.id);

  // The new session's run executes a bash tool call; its tool_start must be
  // rendered. With the old unsubscribe-without-resubscribe bug the event
  // never reached the console.
  faux.setResponses([
    fauxAssistantMessage([
      fauxText("Checking the workspace."),
      fauxToolCall("bash", { command: "echo hi" }),
    ]),
    fauxAssistantMessage("Done."),
  ]);

  // /new → pick model (search + select provider, search + select model),
  // then a prompt in the new session, then exit.
  withPrompts([
    "/new",
    faux.provider.id,
    "1",
    faux.getModel().id,
    "1",
    "bash echo hi",
    null,
  ]);

  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await runRepl(core, session.id);
  } finally {
    console.log = original;
  }

  assertStringIncludes(logs.join("\n"), "⚙ bash");
  core.close();
});
