import { fauxAssistantMessage, fauxText, fauxToolCall } from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import { CODE_EXECUTION_PROVIDER } from "./agent/code-execution-context.ts";
import type { AgentMessage, LumiscaCore } from "./mod.ts";
import {
  TOOL_BASH,
  TOOL_EXECUTE,
  TOOL_READ,
  TOOL_SEARCH,
} from "./shared/mod.ts";
import {
  makeWorkspace,
  promptSession,
  removeDirRetry,
  setup,
  toolText,
} from "./test-utils.ts";

/** Every text block of the session's tool results, in order. */
function toolResultTexts(core: LumiscaCore, sessionId: string): string[] {
  return core
    .getAgent(sessionId)!
    .messages.filter(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
        message.role === "toolResult",
    )
    .map((message) => toolText(message));
}

Deno.test("code execution is off by default", async () => {
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    assertEquals(core.isCodeExecutionEnabled(), false);
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const names = core
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assert(names.includes(TOOL_READ), names.join(","));
    assertEquals(names.includes(TOOL_EXECUTE), false);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("code execution: the model is given execute and nothing else", async () => {
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    core.setCodeExecutionEnabled(true);
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const names = core
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assertEquals(names, [TOOL_EXECUTE]);
    // tool_search travels inside the catalog instead: a program is where a
    // name is looked up, so the agent must not carry it.
    assertEquals(names.includes(TOOL_SEARCH), false);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("code execution: a program runs the session's real tools", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    await Deno.writeTextFile(`${root}/hello.txt`, "code execution works");
    core.setCodeExecutionEnabled(true);
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(TOOL_EXECUTE, {
          // A tool's paths are the session's, not the program's: the read
          // tool resolves against the workspace folders.
          code:
            'const names = await tools.tool_search({ query: "read" });\n' +
            `const body = await tools.read({ path: ${JSON.stringify(`${root}/hello.txt`)} });\n` +
            "return { found: names.includes('read'), body };",
        }),
      ]),
      fauxAssistantMessage("Read it."),
    ]);
    await promptSession(core, session.id, "read hello.txt");

    const results = toolResultTexts(core, session.id);
    assertEquals(results.length, 1, results.join("\n---\n"));
    const text = results[0]!;
    assert(text.includes("[calls]"), text);
    assert(text.includes("read"), text);
    assert(text.includes("code execution works"), text);
    assert(text.includes("found: true"), text);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("code execution: the note about it is published once", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    core.setCodeExecutionEnabled(true);
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    faux.setResponses([fauxAssistantMessage([fauxText("Nothing to do.")])]);
    await promptSession(core, session.id, "hello");
    const notes = core
      .getAgent(session.id)!
      .messages.filter(
        (message) =>
          message.role === "context" &&
          message.provider === CODE_EXECUTION_PROVIDER,
      );
    assertEquals(notes.length, 1, "the note is published exactly once");
    const prompt = core.getAgent(session.id)!.agent.state.systemPrompt;
    assertEquals(prompt.includes("Code execution is on"), false);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("code execution: the toggle rebuilds an open session", async () => {
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const before = core
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assert(before.includes(TOOL_BASH), before.join(","));

    core.setCodeExecutionEnabled(true);
    assertEquals(
      core.getAgent(session.id)!.agent.state.tools.map((tool) => tool.name),
      [TOOL_EXECUTE],
    );

    core.setCodeExecutionEnabled(false);
    const after = core
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assert(after.includes(TOOL_BASH), after.join(","));
    assertEquals(after.includes(TOOL_EXECUTE), false);
    assertEquals(core.isCodeExecutionEnabled(), false);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});
