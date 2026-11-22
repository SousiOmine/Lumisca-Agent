import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
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
  return core.services.sessions
    .getAgent(sessionId)!
    .messages.filter(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
        message.role === "toolResult",
    )
    .map((message) => toolText(message));
}

test("scripting tool call is off by default", async () => {
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    assertEquals(core.capabilities.isCodeExecutionEnabled(), false);
    const session = await core.services.sessions.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const names = core.services.sessions
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assert(names.includes(TOOL_READ), names.join(","));
    assertEquals(names.includes(TOOL_EXECUTE), false);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

test("scripting tool call: the model is given execute and nothing else", async () => {
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    core.capabilities.setCodeExecutionEnabled(true);
    const session = await core.services.sessions.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const names = core.services.sessions
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

test("scripting tool call: a program runs the session's real tools", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    await fsp.writeFile(`${root}/hello.txt`, "scripting tool call works");
    core.capabilities.setCodeExecutionEnabled(true);
    const session = await core.services.sessions.createSession({
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
    assert(text.includes("scripting tool call works"), text);
    assert(text.includes("found: true"), text);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

test("scripting tool call: the system prompt declares the initial tools", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    core.capabilities.setCodeExecutionEnabled(true);
    const session = await core.services.sessions.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const prompt = core.services.sessions.getAgent(session.id)!.agent.state
      .systemPrompt;
    assert(prompt.includes("## Scripting tool call"), prompt);
    assert(prompt.includes("declare const tools"), prompt);
    assert(prompt.includes("read(args:"), prompt);
    assert(prompt.includes("tool_search(args:"), prompt);
    assert(prompt.includes("declare function store"), prompt);
    assert(prompt.includes("declare function load"), prompt);
    // A registry tool is dynamic: it is found through tool_search, not
    // declared in the prompt.
    assert(!prompt.includes("pdf_read_pages"), prompt);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(TOOL_EXECUTE, {
          code:
            'const found = await tools.tool_search({ query: "pdf" });\n' +
            "return found;",
        }),
      ]),
      fauxAssistantMessage("Found it."),
    ]);
    await promptSession(core, session.id, "find the pdf tool");
    const results = toolResultTexts(core, session.id);
    assertEquals(results.length, 1, results.join("\n---\n"));
    assert(results[0]!.includes("pdf_read_pages"), results[0]);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});

test("scripting tool call: the toggle rebuilds an open session", async () => {
  const { core, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    const session = await core.services.sessions.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const before = core.services.sessions
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assert(before.includes(TOOL_BASH), before.join(","));

    core.capabilities.setCodeExecutionEnabled(true);
    assertEquals(
      core.services.sessions
        .getAgent(session.id)!
        .agent.state.tools.map((tool) => tool.name),
      [TOOL_EXECUTE],
    );

    core.capabilities.setCodeExecutionEnabled(false);
    const after = core.services.sessions
      .getAgent(session.id)!
      .agent.state.tools.map((tool) => tool.name);
    assert(after.includes(TOOL_BASH), after.join(","));
    assertEquals(after.includes(TOOL_EXECUTE), false);
    assertEquals(core.capabilities.isCodeExecutionEnabled(), false);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});
test("scripting tool call: the store survives closing and reopening the session", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  try {
    core.capabilities.setCodeExecutionEnabled(true);
    const session = await core.services.sessions.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(TOOL_EXECUTE, {
          code: 'store("cursor", { page: 2 }); return "saved";',
        }),
      ]),
      fauxAssistantMessage("Saved."),
    ]);
    await promptSession(core, session.id, "save the cursor");

    await core.services.sessions.closeSession(session.id);
    core.services.sessions.openSession(session.id);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(TOOL_EXECUTE, { code: 'return load("cursor");' }),
      ]),
      fauxAssistantMessage("Loaded."),
    ]);
    await promptSession(core, session.id, "load the cursor");
    const results = toolResultTexts(core, session.id);
    const last = results[results.length - 1]!;
    assert(last.includes("{ page: 2 }"), last);
  } finally {
    await core.close();
    await removeDirRetry(root);
  }
});
