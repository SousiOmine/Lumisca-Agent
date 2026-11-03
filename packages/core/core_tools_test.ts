import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals, assertThrows } from "@std/assert";
import type {
  AgentMessage,
  BrowserBackend,
  ClientEvent,
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  Point,
  RawCapture,
  Rect,
} from "./mod.ts";
import { LumiscaCore } from "./mod.ts";

import {
  TOOL_BROWSER_OPEN,
  TOOL_CALL,
  TOOL_COMPUTER_SCREENSHOT,
  TOOL_PDF_READ_PAGES,
  TOOL_SEARCH,
} from "./shared/mod.ts";
import { MCP_TOOLS_PROVIDER, ON_DEMAND_TOOLS_NOTE } from "./mcp/context.ts";

import { promptSession, removeDirRetry } from "./test-utils.ts";

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
class FakeBrowserBackend implements BrowserBackend {
  opens: Array<{ url: string; width?: number; height?: number }> = [];

  open(options: { url: string; width?: number; height?: number }) {
    this.opens.push(options);
    return Promise.resolve({
      url: options.url,
      title: "Lab",
      readyState: "complete",
    });
  }
  observe(): Promise<never> {
    throw new Error("unused");
  }
  act(): Promise<never> {
    throw new Error("unused");
  }
  wait(): Promise<never> {
    throw new Error("unused");
  }
  screenshot(): Promise<never> {
    throw new Error("unused");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Capture every LLM call: model id + messages, in call order. */
class FakeComputerHost implements ComputerHost {
  readonly captures: Rect[] = [];
  readonly actions: ComputerAction[] = [];

  capabilities = { windows: true, cursor: true };

  describe(): string {
    return "fake, 256×144 primary";
  }
  displays() {
    return [{
      index: 0,
      primary: true,
      bounds: { x: 0, y: 0, width: 256, height: 144 },
    }];
  }
  cursor(): Point | undefined {
    return { x: 3, y: 4 };
  }
  windows() {
    return [];
  }
  capture(region: Rect): Promise<RawCapture> {
    this.captures.push(region);
    return Promise.resolve({
      screen: region,
      pixels: new Uint8Array(region.width * region.height * 4),
      width: region.width,
      height: region.height,
    });
  }
  act(action: ComputerAction): Promise<ComputerActionResult> {
    this.actions.push(action);
    return Promise.resolve({
      cursor: { x: 3, y: 4 },
      steps: 8,
      durationMs: 104,
    });
  }
  close(): void {
    // nothing to release
  }
}

/** Wait for the next `question` event of a session (the ask tool fired).
 * The run blocks until the test answers. */
function waitForQuestion(
  core: LumiscaCore,
  sessionId: string,
): Promise<Extract<ClientEvent, { type: "question" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("question event never arrived")),
      5000,
    );
    const unsubscribe = core.subscribe((event) => {
      if (event.type === "question" && event.sessionId === sessionId) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

Deno.test("workspace update rebuilds session tools", async () => {
  const { core, faux: _faux, providerId, modelId } = setup();
  const { ws, root } = await makeWorkspace(core);
  const extra = await Deno.makeTempDir({ prefix: "lumisca-extra-" });

  await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });
  const updated = await core.updateWorkspace(ws.id, {
    name: "renamed",
    folders: [root, extra],
  });
  assertEquals(updated.name, "renamed");
  assertEquals(updated.folders.length, 2);

  const fetched = core.getWorkspace(ws.id);
  assertEquals(fetched !== undefined, true);
  assertEquals(fetched!.name, "renamed");
  assertEquals(fetched!.folders.length, 2);

  core.close();
  await removeDirRetry(root);
  await removeDirRetry(extra);
});

Deno.test("browser tools are discoverable via tool_search, never preloaded", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const backend = new FakeBrowserBackend();
  core.setBrowserBackend(backend);
  try {
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    // The browser definitions stay in the session's registry (seeded by
    // the pool at open): the agent's tool set must not contain them —
    // finding them requires tool_search, exactly like MCP tools.
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("browser_")),
      false,
      "browser tools must stay out of the agent tool set",
    );
    // The registry is seeded synchronously at open (no MCP servers here,
    // so discovery contributes nothing) — the search/call pair is already
    // attached and the on-demand-tools note is published as context.
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        agent.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "search/call pair must be attached for the browser tools",
    );
    // The built-in web-browser skill is advertised in the session's skill
    // catalog (a context message published before the first run), not in
    // the system prompt.
    assertEquals(
      agent.agent.state.systemPrompt.includes("web-browser"),
      false,
      "the prompt must stay free of per-session skill data",
    );

    // The model searches for the tool, then calls it through tool_call;
    // the call reaches the browser backend.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "browser_open" }),
      ]),
      fauxAssistantMessage([
        fauxText("Opening."),
        fauxToolCall(TOOL_CALL, {
          name: TOOL_BROWSER_OPEN,
          args: { url: "http://127.0.0.1:5173/" },
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "Open the app in the browser");

    // The on-demand-tools note is published by that run as a context
    // message, before its user message — never appended to the prompt.
    const running = core.getAgent(session.id)!;
    const notes = contextMessages(running, MCP_TOOLS_PROVIDER);
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(notes[0]!.body, ON_DEMAND_TOOLS_NOTE);
    assert(
      running.messages.indexOf(notes[0]!) <
        running.messages.findIndex((m) => m.role === "user"),
      "the note must precede the run's user message",
    );
    assertEquals(
      running.agent.state.systemPrompt.includes("tool_search"),
      false,
      "the prompt must stay free of the on-demand-tools note",
    );

    // The skill catalog went in before the user message and lists the
    // built-in browser skill.
    const catalog = core.getAgent(session.id)!.messages.find(
      (m) => m.role === "context" && m.provider === "skills",
    );
    assert(
      catalog !== undefined && catalog.role === "context",
      "expected a skill catalog message",
    );
    assert(
      catalog.body.includes("- web-browser:"),
      "the built-in web-browser skill must be listed with a backend attached",
    );

    assertEquals(backend.opens.length, 1);
    assertEquals(backend.opens[0]!.url, "http://127.0.0.1:5173/");
    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 2);
    const tr = toolResults[1] as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.isError, false, `tool call failed: ${tr.content[0]?.text}`);
    assert(
      tr.content[0]!.text.includes("Opened http://127.0.0.1:5173/"),
      `unexpected open result: ${tr.content[0]!.text}`,
    );
  } finally {
    core.close();
  }
});

Deno.test("pdf tool is seeded into the session registry via tool_search", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  try {
    // No browser backend, no MCP servers: the PDF page-as-image tool is
    // still seeded by the pool at open.
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_PDF_READ_PAGES),
      false,
      "the pdf tool must stay out of the agent tool set",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        agent.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "search/call pair must be attached for the pdf tool",
    );

    // The model finds it through tool_search.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "pdf" }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "What PDF tools exist?");

    const messages = core.getAgent(session.id)!.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    assertEquals(toolResults.length, 1);
    const tr = toolResults[0] as {
      content: Array<{ type: string; text: string }>;
    };
    assert(
      tr.content[0]!.text.includes(TOOL_PDF_READ_PAGES),
      `pdf tool not discoverable: ${tr.content[0]!.text}`,
    );
  } finally {
    core.close();
  }
});

Deno.test("computer use: the tools are seeded via tool_search only when enabled", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const host = new FakeComputerHost();
  core.setComputerHost({ available: true, host });
  try {
    // Disabled by default: nothing seeded, no skill advertised.
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: providerId,
      modelId,
    });
    const disabled = core.getAgent(session.id)!;
    assertEquals(
      disabled.agent.state.tools.some((t) => t.name.startsWith("computer_")),
      false,
      "definitions must never be preloaded",
    );
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      false,
      "the skill must not be advertised while the feature is off",
    );
    assertEquals(core.isComputerUseEnabled(), false);

    // Enabling applies to the open session immediately (the pool rebuilds
    // it) and its registry now holds the family.
    await core.setComputerUseEnabled(true);
    const enabled = core.getAgent(session.id)!;
    assert(enabled !== disabled, "enabling must rebuild the open agent");
    assertEquals(core.isComputerUseEnabled(), true);
    assertEquals(
      enabled.agent.state.tools.some((t) => t.name.startsWith("computer_")),
      false,
      "the family stays out of the preloaded tool set",
    );
    assertEquals(
      enabled.agent.state.tools.some((t) => t.name === TOOL_SEARCH) &&
        enabled.agent.state.tools.some((t) => t.name === TOOL_CALL),
      true,
      "the search/call pair must be attached for the computer tools",
    );
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      true,
      "the built-in skill must be advertised once the feature is on",
    );

    // The model finds the tool through tool_search and drives the host
    // through tool_call.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "computer" }),
      ]),
      fauxAssistantMessage([
        fauxText("Capturing."),
        fauxToolCall(TOOL_CALL, {
          name: TOOL_COMPUTER_SCREENSHOT,
          args: {},
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "Look at the screen");

    // The run published the on-demand-tools note as a context message,
    // ahead of its user message — the prompt stays free of it.
    const notes = contextMessages(
      core.getAgent(session.id)!,
      MCP_TOOLS_PROVIDER,
    );
    assertEquals(notes.length, 1, "the note is published exactly once");
    assertEquals(notes[0]!.body, ON_DEMAND_TOOLS_NOTE);
    assertEquals(
      core.getAgent(session.id)!.agent.state.systemPrompt.includes(
        "tool_search",
      ),
      false,
      "the prompt must stay free of the on-demand-tools note",
    );

    assertEquals(host.captures, [{ x: 0, y: 0, width: 256, height: 144 }]);
    const toolResults = core.getAgent(session.id)!.messages.filter(
      (m) => m.role === "toolResult",
    );
    assertEquals(toolResults.length, 2);
    const tr = toolResults[1] as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    assertEquals(tr.isError, false, `tool call failed: ${tr.content[0]?.text}`);
    assert(
      tr.content[0]!.text.includes("image 256×144"),
      `unexpected screenshot result: ${tr.content[0]!.text}`,
    );
    // The skill catalog published before the run lists the built-in skill.
    const catalog = core.getAgent(session.id)!.messages.find(
      (m) => m.role === "context" && m.provider === "skills",
    );
    assert(
      catalog !== undefined && catalog.role === "context" &&
        catalog.body.includes("- computer-use:"),
      "the built-in computer-use skill must be listed while enabled",
    );

    // Disabling removes the family from the registry again (the rebuild),
    // while the PDF tool keeps the search/call pair attached.
    await core.setComputerUseEnabled(false);
    const off = core.getAgent(session.id)!;
    assertEquals(core.isComputerUseEnabled(), false);
    assertEquals(
      off.agent.state.tools.some((t) => t.name === TOOL_SEARCH),
      true,
      "the PDF tool keeps the search/call pair attached",
    );
    assertEquals(
      core.listSkills(ws.id).some((s) => s.name === "computer-use"),
      false,
      "the skill disappears with the capability",
    );
  } finally {
    core.close();
  }
});

Deno.test("computer use: enabling asks the machine again, so a late desktop is usable", async () => {
  // A server started by systemd runs before the desktop session does, so at
  // startup there is nothing to ask and the verdict is "no host". By the
  // time the user flips the toggle the desktop is up: the toggle must ask
  // again instead of repeating a verdict made minutes ago at boot.
  const { core } = setup();
  const host = new FakeComputerHost();
  core.setComputerHost({
    available: false,
    reason: "the desktop was not up when the server started (test)",
  });
  let probes = 0;
  core.setComputerHostProbe(() => {
    probes++;
    return Promise.resolve({ available: true, host });
  });
  try {
    await core.setComputerUseEnabled(true);
    assertEquals(probes, 1, "enabling must ask the machine");
    assertEquals(core.isComputerUseEnabled(), true);
    assertEquals(core.getComputerHost(), host, "the new host is attached");
  } finally {
    core.close();
  }
});

Deno.test("ask tool blocks the run until the user answers, then continues", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
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

  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));

  // The run blocks on the ask tool until the answer arrives.
  const run = promptSession(core, session.id, "Which language should I use?");
  const question = await waitForQuestion(core, session.id);
  assertEquals(question.toolCallId.length > 0, true);
  core.answerQuestion(question.sessionId, question.toolCallId, [
    { id: "lang", values: ["Deno"] },
  ]);
  await run;

  // The tool result carried the answer and the run continued normally.
  const messages = core.getAgent(session.id)!.messages;
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 1);
  const resultText = (toolResults[0] as { content: Array<{ text: string }> })
    .content[0]!.text;
  assertEquals(resultText, "Answers from the user:\n- Which language?: Deno");
  const last = messages.at(-1) as { content: Array<{ text: string }> };
  assertEquals(last.content[0]!.text, "Great choice!");
  assertEquals(events.some((e) => e.type === "question"), true);

  unsubscribe();
  core.close();
});

Deno.test("todo tool records the whole plan and replaces it on the next call", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("todo", {
        phases: [{
          name: "実装",
          tasks: [{ name: "調査する" }, { name: "実装する" }, {
            name: "テストする",
          }],
        }],
      }),
    ]),
    fauxAssistantMessage([
      fauxToolCall("todo", {
        phases: [{
          name: "実装",
          tasks: [
            { name: "調査する", status: "completed" },
            { name: "実装する", status: "in_progress" },
            { name: "テストする" },
          ],
        }],
      }),
    ]),
    fauxAssistantMessage("finished!"),
  ]);

  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  await promptSession(core, session.id, "Plan and track the work");

  // Every call emitted a `todo` snapshot event for this session.
  const todoEvents = events.filter(
    (e): e is Extract<ClientEvent, { type: "todo" }> => e.type === "todo",
  );
  assertEquals(todoEvents.length, 2);
  const planned = todoEvents[0]!.todos[0]!.tasks.map((t) => [t.name, t.status]);
  assertEquals(planned, [
    ["調査する", "pending"],
    ["実装する", "pending"],
    ["テストする", "pending"],
  ]);
  // The second call sent the whole plan again, with the new statuses.
  const updated = todoEvents.at(-1)!.todos[0]!.tasks.map((t) => [
    t.name,
    t.status,
  ]);
  assertEquals(updated, [
    ["調査する", "completed"],
    ["実装する", "in_progress"],
    ["テストする", "pending"],
  ]);

  // The results report the counts back to the agent.
  const messages = core.getAgent(session.id)!.messages;
  const toolResults = messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 2);
  const firstResult = (toolResults[0] as { content: Array<{ text: string }> })
    .content[0]!.text;
  assertEquals(firstResult, "Updated todo list: 3 pending.");
  const last = messages.at(-1) as { content: Array<{ text: string }> };
  assertEquals(last.content[0]!.text, "finished!");

  unsubscribe();
  core.close();
});

Deno.test("rewind while a question is pending aborts the run cleanly", async () => {
  const { core, faux, providerId, modelId } = setup();
  const { ws } = await makeWorkspace(core);
  const session = await core.createSession({
    workspaceId: ws.id,
    modelProvider: providerId,
    modelId,
  });

  faux.setResponses([
    fauxAssistantMessage([
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

  const run = promptSession(core, session.id, "Which language should I use?");
  const question = await waitForQuestion(core, session.id);

  // Rewind must not hang on the blocked run: the pending ask is rejected
  // first, letting the loop unwind.
  const messages = core.getAgent(session.id)!.messages;
  const userMessage = messages.find((m) => m.role === "user")!;
  await core.rewind(session.id, userMessage.timestamp);

  // The ask is gone: a late answer is refused.
  assertThrows(
    () =>
      core.answerQuestion(session.id, question.toolCallId, [
        { id: "lang", values: ["Deno"] },
      ]),
    Error,
    "No pending question for tool call",
  );
  await run;

  core.close();
});

// ---- context compaction (see ai/context-compaction.ts) ------------------

/** A model whose window is small enough that a few turns of history cross
 * the pressure threshold; the completion reserve is part of the budget the
 * provider validates against (`window - outputCap`). */
