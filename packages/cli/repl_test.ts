import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { LumiscaCore } from "@lumisca/core";
import { handleCommand, runRepl } from "./repl.ts";
import { withPromptFn } from "./ui.ts";

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

/** Run `body` with the given prompts fed in order; anything beyond the
 * list returns null. */
function withPrompts<T>(
  sequence: Array<string | null>,
  body: () => Promise<T>,
): Promise<T> {
  let i = 0;
  return withPromptFn(() => sequence[i++] ?? null, body);
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
  // pickModel only offers providers explicitly configured in Lumisca.
  await core.setProviderApiKey(providerId, "test-key");

  // pickModel: search + select the faux provider, then its model.
  await withPrompts(
    [faux.provider.id, "1", faux.getModel().id, "1"],
    async () => {
      const next = await handleCommand(core, "/new", session.id);
      assertEquals(typeof next, "string");
      assertEquals(core.getSession(next!)?.workspaceId, ws.id);
    },
  );
  core.close();
});

Deno.test("handleCommand /model switches the session model", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);
  await core.setProviderApiKey(providerId, "test-key");

  await withPrompts(
    [faux.provider.id, "1", faux.getModel().id, "1"],
    async () => {
      const result = await handleCommand(core, "/model", session.id);
      assertEquals(result, undefined);
      assertEquals(core.getSession(session.id)?.modelProvider, providerId);
      assertEquals(core.getSession(session.id)?.modelId, modelId);
    },
  );
  core.close();
});

Deno.test("handleCommand /keys stores the API key", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  await withPrompts(["anthropic", "sk-test-123"], async () => {
    const result = await handleCommand(core, "/keys", session.id);
    assertEquals(result, undefined);
    // The stored key resolves through the public, network-free auth check
    // (behavioral assertion — no reaching into the storage format).
    assertEquals(await core.hasProviderAuth("anthropic"), true);
  });
  core.close();
});

Deno.test("handleCommand /resume opens the selected session", async () => {
  const { core, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);

  await withPrompts(["1"], async () => {
    const next = await handleCommand(core, "/resume", session.id);
    assertEquals(next, session.id);
  });
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
  const prompts = [
    "/new",
    faux.provider.id,
    "1",
    faux.getModel().id,
    "1",
    "bash echo hi",
    null,
  ];

  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await withPrompts(prompts, () => runRepl(core, session.id));
  } finally {
    console.log = original;
  }

  assertStringIncludes(logs.join("\n"), "⚙ bash");
  core.close();
});

Deno.test("runRepl answers the agent's ask inline instead of blocking", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { session } = await makeSession(core, providerId, modelId);
  await core.openSession(session.id);

  // The agent asks a question (the ask tool): the run blocks until the
  // REPL answers it inline (the question event handler prompts + resolves
  // via core.answerQuestion). Without the handler the run would hang.
  faux.setResponses([
    fauxAssistantMessage([
      fauxText("I need input."),
      fauxToolCall("ask", {
        questions: [{
          id: "q1",
          question: "Which language?",
          options: [{ label: "Rust" }, { label: "Go" }],
        }],
      }),
    ]),
    fauxAssistantMessage("Got it."),
  ]);

  const prompts = ["ask me", "1", null];
  const logs: string[] = [];
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  // Streamed deltas go to stdout, not console.log.
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await withPrompts(prompts, () => runRepl(core, session.id));
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }

  const rendered = logs.join("\n");
  assertStringIncludes(rendered, "Which language?");
  // The run completed after the answer (the second assistant message
  // streamed), so the ask did not block the REPL forever.
  assertStringIncludes(chunks.join(""), "Got it.");
  core.close();
});
