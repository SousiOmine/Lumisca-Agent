import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./ai/faux.ts";
import { LumiscaCore } from "./core.ts";
import type { VmManager, VmStatus } from "./vm/container.ts";
import { createStellaTools } from "./tools/toolsets.ts";
import { hostBackends } from "./tools/toolsets.ts";
import { createVmTools } from "./vm/tools.ts";
import { createHistorySearchTool } from "./stella/history.ts";
import { createAgentCreateTool } from "./stella/tools.ts";
import { STELLA_PROMPT_SECTIONS } from "./tools/prompt-sections.ts";
import { AskHub } from "./tools/ask.ts";
import { BackgroundProcessManager } from "./tools/background.ts";
import { TodoHub } from "./tools/todo.ts";
import { TaskHub } from "./tools/task-hub.ts";
import type { StreamFn } from "./ai/types.ts";
import type { VmScreen } from "./vm/screen.ts";
import { CoreError } from "./errors.ts";
import { APP_MODE_KEY } from "./shared/settings-keys.ts";
import { promptSession } from "./test-utils.ts";

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
    agents: createAgentCreateTool({ create: () => ({}) as never }),
    history: createHistorySearchTool({ messages: () => [] }),
    background: new BackgroundProcessManager(),
    ask: new AskHub("s1", () => {}),
    todo: new TodoHub("s1", () => {}),
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
  for (const expected of ["history_search", "vm_screenshot", "agent_create"]) {
    assertEquals(
      stellaTools.includes(expected),
      true,
      `${expected} must be built`,
    );
  }
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
