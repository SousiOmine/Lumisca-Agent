import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./ai/faux.ts";
import { LumiscaCore } from "./core.ts";
import type { VmManager, VmStatus } from "./vm/container.ts";
import { createStellaTools } from "./tools/toolsets.ts";
import { hostBackends } from "./tools/toolsets.ts";
import { createVmTools } from "./vm/tools.ts";
import { createHistorySearchTool } from "./session/history.ts";
import { createChatUiTool } from "./tools/chat-ui.ts";
import { STELLA_PROMPT_SECTIONS } from "./tools/prompt-sections.ts";
import { BackgroundProcessManager } from "./tools/background.ts";
import { TaskHub } from "./tools/task-hub.ts";
import type { StreamFn } from "./ai/types.ts";
import type { VmScreen } from "./vm/screen.ts";
import { CoreError } from "./errors.ts";
import { APP_MODE_KEY } from "./shared/settings-keys.ts";
import { MINI_PNG, promptSession } from "./test-utils.ts";
import { SessionAttachmentStore } from "./session/attachments.ts";

/**
 * stella mode at the core level: the mode switch, the single conversation and
 * what the session lists do with it.
 *
 * The machine is a stub here (every `podman` call is decided by the test), so
 * these cover the decisions the core makes — when stella is offered, what the
 * conversation is called, and that it never appears as a session — rather than
 * the container itself (vm/container_test.ts).
 */

/** A core with a machine and a configured provider (a new session needs one
 * to resolve a default model). */
async function stellaCore(status: VmStatus): Promise<LumiscaCore> {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  core.models.models.setProvider(faux.provider);
  await core.setProviderApiKey(faux.provider.id, "faux-key");
  core.setStellaVm(fakeVm(status));
  return core;
}

function fakeVm(status: VmStatus): VmManager {
  return {
    status: () => Promise.resolve(status),
    start: () => Promise.resolve({ ...status, state: "running" as const }),
    stop: () => Promise.resolve(),
    vncPort: () => Promise.resolve(status.vncPort),
  };
}

const RUNNING: VmStatus = { state: "running", vncPort: 49153, reason: "" };
const NO_PODMAN: VmStatus = {
  state: "podman_missing",
  vncPort: null,
  reason: "podman: command not found",
};

Deno.test("app mode: unset until chosen, then stored", async () => {
  const core = await stellaCore(RUNNING);
  try {
    // No silent default: "not chosen" is its own state, which is what makes
    // the client show the selection screen.
    assertEquals(core.getAppMode(), undefined);
    core.setAppMode("code");
    assertEquals(core.getAppMode(), "code");
    assertEquals(core.getSetting(APP_MODE_KEY), "code");
  } finally {
    void core.close();
  }
});

Deno.test("app mode: an unknown stored value reads as not chosen", async () => {
  const core = await stellaCore(RUNNING);
  try {
    core.setSetting(APP_MODE_KEY, "something-else");
    assertEquals(core.getAppMode(), undefined);
  } finally {
    void core.close();
  }
});

Deno.test("app mode: stella is refused when the machine cannot exist here", async () => {
  // No machine attached at all: there is nothing to start, so the mode must
  // not be storable (a mode whose whole premise is missing).
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  try {
    const availability = await core.getStellaAvailability();
    assertEquals(availability.available, false);
    const error = assertThrows(() => core.setAppMode("stella"), CoreError);
    assert(
      error.message.includes("not set up"),
      `the reason must say the machine is missing: ${error.message}`,
    );
    assertEquals(core.getAppMode(), undefined);
  } finally {
    void core.close();
  }
});

Deno.test("app mode: a machine that is merely not running still allows stella", async () => {
  // This is the point of starting on demand: podman missing is fatal, a
  // stopped container is not (the first message starts it).
  const core = await stellaCore(NO_PODMAN);
  try {
    void core;
  } finally {
    void core.close();
  }
  const stopped = await stellaCore({
    state: "stopped",
    vncPort: null,
    reason: "",
  });
  try {
    stopped.setAppMode("stella");
    assertEquals(stopped.getAppMode(), "stella");
  } finally {
    void stopped.close();
  }
});

Deno.test("app mode: no machine attached reports its own reason", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  try {
    const availability = await core.getStellaAvailability();
    assertEquals(availability.available, false);
    if (!availability.available) {
      assert(availability.reason.includes("not set up"), availability.reason);
    }
    await assertRejects(
      () => core.getOrCreateStellaSession(),
      CoreError,
    );
  } finally {
    void core.close();
  }
});

Deno.test("app mode: switching away never stops the machine", async () => {
  let stops = 0;
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  try {
    core.setStellaVm({
      ...fakeVm(RUNNING),
      stop: () => {
        stops++;
        return Promise.resolve();
      },
    });
    // The client reads the status before offering the mode; the switch
    // requires that verdict to exist.
    await core.getStellaAvailability();
    core.setAppMode("stella");
    core.setAppMode("code");
    // Building a machine takes minutes; flipping the view must not throw it
    // away.
    assertEquals(stops, 0);
  } finally {
    void core.close();
  }
});

Deno.test("stella conversation: created once and kept out of the session lists", async () => {
  const core = await stellaCore(RUNNING);
  try {
    core.createStellaAgent({ name: "Aide", role: "Help with the work." });
    const first = await core.getOrCreateStellaSession();
    assertEquals(first.stella, true);
    // A second call returns the same conversation: stella has one.
    const again = await core.getOrCreateStellaSession();
    assertEquals(again.id, first.id);
    // No session list ever offers it: it is not a session the user opened.
    assertEquals(core.listSessions(), []);
    // It is still reachable by id, so the client can drive it.
    assertEquals(core.getSession(first.id)?.stella, true);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: each agent has its own", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const first = core.createStellaAgent({ name: "First", role: "r" });
    const second = core.createStellaAgent({ name: "Second", role: "r" });
    const a = await core.getOrCreateStellaSession(first.id);
    const b = await core.getOrCreateStellaSession(second.id);
    // Two agents, two conversations. A shared row would make them one person
    // with a split personality.
    assert(a.id !== b.id, `${a.id} == ${b.id}`);
    assertEquals(a.agentId, first.id);
    assertEquals(b.agentId, second.id);
    // Re-asking for the same agent returns the same conversation.
    assertEquals((await core.getOrCreateStellaSession(first.id)).id, a.id);
    // Neither appears in the session list.
    assertEquals(core.listSessions(), []);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: deleting an agent takes its conversation", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({ name: "Gone", role: "r" });
    const session = await core.getOrCreateStellaSession(agent.id);
    await core.deleteStellaAgent(agent.id);
    assertEquals(core.getSession(session.id), undefined);
    assertEquals(core.listStellaAgents(), []);
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: an icon is stored, replaced and cleared as one file", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({ name: "Aide", role: "r" });
    assertEquals(agent.icon, "");

    const first = await core.setStellaAgentIcon(agent.id, {
      bytes: MINI_PNG,
      extension: ".png",
    });
    assertEquals(first.icon, core.getStellaAgent(agent.id)?.icon);
    const firstFile = await core.resolveStellaAgentIcon(agent.id, first.icon);
    assertEquals(firstFile?.mimeType, "image/png");

    // Replacing writes a new file and drops the one it replaced: an icon URL
    // is cacheable forever, so the name has to change with the picture.
    const second = await core.setStellaAgentIcon(agent.id, {
      bytes: MINI_PNG,
      extension: ".png",
    });
    assert(second.icon !== first.icon);
    assert(
      (await core.resolveStellaAgentIcon(agent.id, second.icon)) !== undefined,
    );
    assertEquals(
      await core.resolveStellaAgentIcon(agent.id, first.icon),
      undefined,
    );

    // Clearing returns the row to its initial and removes the file.
    const cleared = await core.clearStellaAgentIcon(agent.id);
    assertEquals(cleared.icon, "");
    assertEquals(
      await core.resolveStellaAgentIcon(agent.id, second.icon),
      undefined,
    );
    // Clearing twice is a no-op, not a failure.
    assertEquals((await core.clearStellaAgentIcon(agent.id)).icon, "");
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: deleting an agent drops its icon files", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({ name: "Gone", role: "r" });
    const withIcon = await core.setStellaAgentIcon(agent.id, {
      bytes: MINI_PNG,
      extension: ".png",
    });
    await core.deleteStellaAgent(agent.id);
    // The picture belonged to the agent; nothing can name it now.
    assertEquals(
      await core.resolveStellaAgentIcon(agent.id, withIcon.icon),
      undefined,
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: an icon for a missing agent is refused", async () => {
  const core = await stellaCore(RUNNING);
  try {
    // The user deleted the agent while the picture was being saved.
    await assertRejects(
      () =>
        core.setStellaAgentIcon("gone", {
          bytes: MINI_PNG,
          extension: ".png",
        }),
      CoreError,
      "Agent not found",
    );
    await assertRejects(
      () => core.clearStellaAgentIcon("gone"),
      CoreError,
      "Agent not found",
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: an icon that is not an image is refused by the core", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({ name: "Aide", role: "r" });
    const error = await assertRejects(
      () =>
        core.setStellaAgentIcon(agent.id, {
          bytes: new TextEncoder().encode("<html></html>"),
          extension: ".png",
        }),
      CoreError,
    );
    assertEquals(error.kind, "invalid");
    // The row is untouched: a refused picture must not look like a change.
    assertEquals(core.getStellaAgent(agent.id)?.icon, "");
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: its system prompt is the machine's", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({
      name: "Aide",
      role: "You keep notes and check facts.",
    });
    const session = await core.getOrCreateStellaSession(agent.id);
    const prompt = session.systemPrompt ?? "";
    // The persona is the agent's: its name and the role it was made for.
    assert(prompt.includes('"Aide"'), prompt.slice(0, 120));
    assert(
      prompt.includes("You keep notes and check facts."),
      prompt.slice(0, 300),
    );
    // The machine framing, not the folder-less chat one.
    assert(prompt.includes("virtual"), `prompt: ${prompt.slice(0, 200)}`);
    assert(prompt.includes("/home/agent"), prompt.slice(0, 400));
    // And it is not told it cannot run anything (the chat prompt's opening).
    assert(
      !prompt.includes("running without a file workspace"),
      prompt.slice(0, 200),
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella tool set: eval is absent, the screen tools present", () => {
  const faux = fauxProvider();
  const screen: VmScreen = {
    screenshot: () => Promise.resolve(new Uint8Array()),
    move: () => Promise.resolve(),
    click: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    type: () => Promise.resolve(),
    key: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
  };
  // A workspace is what the tool factory takes; stella's own is folder-less.
  const workspace = {
    id: "w",
    name: "stella",
    folders: [],
    createdAt: 0,
    chat: true,
  };
  const tools = createStellaTools({
    backends: hostBackends(workspace),
    skills: [],
    screen: createVmTools({ screen }),
    history: createHistorySearchTool({ messages: () => [] }),
    attach: {
      store: new SessionAttachmentStore(
        Deno.makeTempDirSync({ prefix: "lumisca-stella-attach-" }),
      ),
      sessionId: "s1",
    },
  });
  const names = tools.map((tool) => tool.name);
  // The coding tools are there...
  for (
    const expected of [
      "read",
      "write",
      "edit",
      "list_dir",
      "grep",
      "glob",
      "bash",
    ]
  ) {
    assert(
      names.includes(expected),
      `missing ${expected}: ${names.join(", ")}`,
    );
  }
  // ...and eval is not: it would run JavaScript in the SERVER process, which
  // is the one thing a stella session must not be able to reach.
  assertEquals(names.includes("eval"), false);
  // The machine's screen is preloaded, not discoverable.
  assert(names.includes("vm_screenshot"), names.join(", "));
  assert(names.includes("vm_act"), names.join(", "));
  // So is the conversation's own history: the turns a checkpoint condensed
  // away are unreachable without it. A caller that passes no history tool
  // (nothing to search) simply has none.
  assert(names.includes("history_search"), names.join(", "));
  // The identity and agent_create are NOT here: they belong to the
  // conversation's own agent, so they are discoverable (tool_search) and
  // live in the session's main registry only — a sub-agent must not rewrite
  // its parent's identity or create siblings, so this set does not take
  // them as options at all.
  assertEquals(names.includes("identity"), false);
  assertEquals(names.includes("agent_create"), false);
  // ask is absent for the same reason todo is: stella's conversation has no
  // panel that could show the question, and a blocked run has no way back.
  assertEquals(names.includes("ask"), false);
  assertEquals(names.includes("todo"), false);
  // The visual tool is gone; a file the agent hands over goes through
  // chat_attach instead (an image inline, anything else as a download).
  assertEquals(names.includes("visual"), false);
  assert(names.includes("chat_attach"), names.join(", "));
  void faux;
});

Deno.test("stella tool set: every preloaded tool has a guideline section", () => {
  // The stella sections are keyed on the preloaded tools, so a tool added
  // without a section would reach a session whose prompt says nothing about
  // it. Built the way the factory builds it (tools/toolsets.ts), not copied
  // by hand — the coding set's equivalent test caught a drifted list once.
  const screen: VmScreen = {
    screenshot: () => Promise.resolve(new Uint8Array()),
    move: () => Promise.resolve(),
    click: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    type: () => Promise.resolve(),
    key: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
  };
  const stellaTools = createStellaTools({
    backends: hostBackends({
      id: "w",
      name: "stella",
      folders: [],
      createdAt: 0,
      chat: true,
    }),
    skills: [],
    screen: createVmTools({ screen }),
    history: createHistorySearchTool({ messages: () => [] }),
    chatUi: createChatUiTool(),
    attach: {
      store: new SessionAttachmentStore(
        Deno.makeTempDirSync({ prefix: "lumisca-stella-sections-" }),
      ),
      sessionId: "s1",
    },
    background: new BackgroundProcessManager(),
    task: new TaskHub({
      sessionId: "s1",
      resolveRuntime: () => {
        throw new Error("no sub-agent run in this test");
      },
      streamFn: (() => {
        throw new Error("no sub-agent run in this test");
      }) as unknown as StreamFn,
      emit: () => {},
    }),
  }).map((tool) => tool.name);

  const covered = new Set(
    STELLA_PROMPT_SECTIONS.flatMap((section) => section.requires ?? []),
  );
  // Tools whose whole contract (arguments, result markers) is stated by the
  // tool's own description, with no cross-call guidance to add. Adding a
  // name here says the tool needs no bullet — never that one was forgotten.
  const noSection = [
    "list_dir",
    "async_bash_status",
    "async_bash_kill",
    "task_output",
  ];
  const unguided = stellaTools.filter((name) =>
    !covered.has(name) && !noSection.includes(name)
  );
  assertEquals(
    unguided,
    [],
    "a stella tool needs a guideline section or an entry in noSection",
  );
  // The invariant is only meaningful while the set is the full one.
  for (
    const expected of [
      "history_search",
      "vm_screenshot",
      "chat_attach",
      "chat_ui",
    ]
  ) {
    assertEquals(
      stellaTools.includes(expected),
      true,
      `${expected} must be built`,
    );
  }
  // The tools that belong to the conversation's own agent are discoverable
  // instead (main registry), so they are absent here by design.
  for (const discoverable of ["identity", "agent_create"]) {
    assertEquals(
      stellaTools.includes(discoverable),
      false,
      `${discoverable} must be discoverable, not preloaded`,
    );
  }
  // `todo` is the one coding tool a stella session does not get: its plan is
  // shown in a progress panel, and this mode's conversation has none.
  assertEquals(
    stellaTools.includes("todo"),
    false,
    "stella must not build todo",
  );
  // `ask` goes with it: the same conversation has no panel to answer it in,
  // and a blocking question would leave the run waiting for nothing.
  assertEquals(stellaTools.includes("ask"), false, "stella must not ask");
});

Deno.test("stella tool set: the prompt teaches the machine, not a workspace", async () => {
  const { buildStellaSystemPrompt } = await import("./tools/system-prompt.ts");
  const prompt = buildStellaSystemPrompt({
    tools: [
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "bash",
      "vm_screenshot",
      "vm_act",
    ],
  });
  // The screens are described only because the tools are there.
  assert(prompt.includes("vm_screenshot"), prompt);
  assert(prompt.includes("vm_act"), prompt);
  // The history search is described for the same reason: a session that was
  // condensed must know the earlier turns are still reachable.
  const withHistory = buildStellaSystemPrompt({
    tools: ["read", "history_search"],
  });
  assert(withHistory.includes("history_search"), withHistory);
  // A session without them gets no such guidance (the sections are
  // tool-gated, like every other section).
  const without = buildStellaSystemPrompt({ tools: ["read", "bash"] });
  assert(!without.includes("vm_screenshot"), without);
  assert(!without.includes("history_search"), without);
});

/** A core with a running machine, one agent and its conversation open.
 * The faux provider is the core's own: a second one would script a model
 * nothing is listening to. */
async function stellaConversation(name: string) {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  core.models.models.setProvider(faux.provider);
  await core.setProviderApiKey(faux.provider.id, "faux-key");
  core.setStellaVm(fakeVm(RUNNING));
  const agent = core.createStellaAgent({ name, role: "r" });
  const session = await core.getOrCreateStellaSession(agent.id);
  return { faux, core, agent, session };
}

/** The text of the last history_search tool result of a session. */
function lastHistoryResult(core: LumiscaCore, sessionId: string): string {
  const result = core.getAgent(sessionId)!.messages.findLast((message) =>
    message.role === "toolResult" && message.toolName === "history_search"
  );
  if (result === undefined || result.role !== "toolResult") {
    throw new Error("history_search did not run");
  }
  return result.content
    .map((block) => block.type === "text" ? block.text : "")
    .join("");
}

Deno.test("stella conversation: history_search is preloaded and reads its own rows", async () => {
  const { faux, core, session } = await stellaConversation("Solo");
  try {
    // The prompt is snapshotted from the tool set, so this is the proof the
    // tool is preloaded for a real stella session — not only for a hand-built
    // tool set.
    assert(
      (session.systemPrompt ?? "").includes("history_search"),
      session.systemPrompt ?? "",
    );

    faux.setResponses([fauxAssistantMessage("Noted.")]);
    await promptSession(core, session.id, "The code word is pelican.");

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("history_search", { query: "pelican" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("found it"),
    ]);
    await promptSession(core, session.id, "Which code word did I give you?");

    // The earlier turn came back from the message store: its words and the
    // count line are both in the result.
    const text = lastHistoryResult(core, session.id);
    assert(text.includes("Found 1 message(s)"), text);
    assert(text.includes("The code word is pelican."), text);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: history_search never reads another agent's rows", async () => {
  const { faux, core, session: sessionA } = await stellaConversation("First");
  try {
    const second = core.createStellaAgent({ name: "Second", role: "r" });
    const sessionB = await core.getOrCreateStellaSession(second.id);

    // The word is said to the first agent only.
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    await promptSession(core, sessionA.id, "The code word is pelican.");

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("history_search", { query: "pelican" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("nothing found"),
    ]);
    await promptSession(core, sessionB.id, "Which code word did I give you?");

    // Each counterpart has their own history: mixing them would answer as
    // somebody else. The head line echoes the query, so the check is on the
    // found count and on the body the other conversation never had.
    const text = lastHistoryResult(core, sessionB.id);
    assert(text.includes("No message matching"), text);
    assert(!text.includes("The code word is pelican."), text);
  } finally {
    await core.close();
  }
});

/** The identity context messages of a session, in transcript order. */
function identityMessages(core: LumiscaCore, sessionId: string) {
  const agent = core.getAgent(sessionId)!;
  return agent.messages.filter((message) =>
    message.role === "context" && message.provider === "identity"
  );
}

Deno.test("stella conversation: the identity a write produces reaches the next run", async () => {
  const { faux, core, agent, session } = await stellaConversation("Scribe");
  try {
    // Nothing is published before the agent writes one: a first turn must
    // not open with an empty identity block.
    assertEquals(identityMessages(core, session.id), []);

    // The agent writes about itself in one turn. The tool is discoverable
    // (main registry), so the turn finds it first and then calls it —
    // exactly the path a real agent takes.
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "identity" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("tool_call", {
          name: "identity",
          args: {
            action: "write",
            content: "I keep the project's notes and know where things are.",
          },
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("Wrote it."),
    ]);
    await promptSession(core, session.id, "Write down what your job is.");
    // The text is stored on the agent row, not in the transcript yet: the
    // run that wrote it already had its context.
    assertEquals(
      core.listStellaAgents().find((a) => a.id === agent.id)?.identity,
      "I keep the project's notes and know where things are.",
    );
    assertEquals(identityMessages(core, session.id), []);

    // ...and the text is in the transcript before the next run's first
    // request. It arrives as a context message, so the snapshotted system
    // prompt is never rewritten (the cache keeps serving its head).
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    await promptSession(core, session.id, "What do you do?");

    const published = identityMessages(core, session.id);
    assertEquals(published.length, 1);
    const message = published[0]!;
    if (message.role !== "context") throw new Error("unreachable");
    assert(
      message.body.includes("I keep the project's notes"),
      message.body,
    );
    // The prompt still carries the role the USER wrote, unchanged: the
    // identity is context, not a prompt edit.
    assertEquals(
      (core.getSession(session.id)?.systemPrompt ?? "").includes(
        "I keep the project's notes",
      ),
      false,
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: each agent's identity is its own", async () => {
  const { faux, core, session: sessionA } = await stellaConversation("One");
  try {
    const second = core.createStellaAgent({ name: "Two", role: "r" });
    const sessionB = await core.getOrCreateStellaSession(second.id);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "identity" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("tool_call", {
          name: "identity",
          args: { action: "write", content: "I am the first." },
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await promptSession(core, sessionA.id, "Who are you?");

    // The other counterpart has written nothing, so its transcript gains no
    // identity message and its agent row stays empty.
    faux.setResponses([fauxAssistantMessage("hello")]);
    await promptSession(core, sessionB.id, "Who are you?");
    assertEquals(identityMessages(core, sessionB.id), []);
    const stored = core.listStellaAgents().find((a) => a.id === second.id);
    assertEquals(stored?.identity, "");
  } finally {
    await core.close();
  }
});

/** The skills listing of the machine's directory, as `scanVmSkillsDir`
 * asks for it: one `podman exec` call whose script prints a marker line and
 * the SKILL.md body per skill. A stub answers that call without a container,
 * so the crossing (machine skills → session catalog) is testable here. */
function vmSkillsRunner(skills: Array<{ name: string; description: string }>) {
  const stdout = skills
    .map((skill) =>
      `\n__SKILL__${skill.name}\n---\nname: ${skill.name}\n` +
      `description: ${skill.description}\n---\n\nBody.\n`
    )
    .join("");
  return {
    run: (command: readonly string[]) => {
      // Only the skills listing answers with content: everything else (the
      // working folder's mkdir, the screen probes) is a no-op success.
      const listing = command.join(" ").includes(".agents/skills");
      return Promise.resolve({
        exitCode: 0,
        stdout: listing ? stdout : "",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    },
    runBytes: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: "",
        truncated: false,
        timedOut: false,
      }),
  };
}

Deno.test("stella conversation: a skill in the machine reaches the published catalog", async () => {
  const faux = fauxProvider();
  // The machine's own skills: they exist nowhere on this host, so a catalog
  // built from workspace folders could not list them. This is the gap the
  // provider seam closed.
  const core = LumiscaCore.forTesting(
    [faux.provider],
    () => ({}),
    vmSkillsRunner([{
      name: "vm-notes",
      description: "How notes are kept inside the machine.",
    }]),
  );
  core.models.models.setProvider(faux.provider);
  await core.setProviderApiKey(faux.provider.id, "faux-key");
  core.setStellaVm(fakeVm(RUNNING));
  try {
    const agent = core.createStellaAgent({
      name: "Keeper",
      role: "Keep notes.",
    });
    const session = await core.getOrCreateStellaSession(agent.id);

    // The skill tool can load it...
    const skills = core.listStellaSkills();
    assert(
      skills.some((skill) => skill.name === "vm-notes"),
      JSON.stringify(skills),
    );

    // ...and the catalog the model reads names it too.
    faux.setResponses([fauxAssistantMessage("Noted.")]);
    await promptSession(core, session.id, "What can you do?");
    const published = core.getAgent(session.id)!.messages.find((message) =>
      message.role === "context" && message.provider === "skills"
    );
    assert(published !== undefined, "the skill catalog must be published");
    if (published.role !== "context") throw new Error("unreachable");
    assert(
      published.body.includes(
        "vm-notes: How notes are kept inside the machine.",
      ),
      published.body,
    );
  } finally {
    await core.close();
  }
});
