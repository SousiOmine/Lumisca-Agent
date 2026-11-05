import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./ai/faux.ts";
import { NO_RESPONSE } from "./agent/silent-reply.ts";
import { LumiscaCore } from "./core.ts";
import type { VmManager, VmStatus } from "./vm/container.ts";
import { createStellaTools } from "./tools/toolsets.ts";
import { hostBackends } from "./tools/toolsets.ts";
import { createVmTools } from "./vm/tools.ts";
import { createHistorySearchTool } from "./session/history.ts";
import { STELLA_PROMPT_SECTIONS } from "./tools/prompt-sections.ts";
import { BackgroundProcessManager } from "./tools/background.ts";
import { TaskHub } from "./tools/task-hub.ts";
import type { StreamFn } from "./ai/types.ts";
import type { WindowPage } from "./session/transcript-window.ts";
import type { StellaEntry } from "./types/stella-conversation.ts";
import type { VmScreen } from "./vm/screen.ts";
import { CoreError } from "./errors.ts";
import { MINI_PNG, promptSession, withTempDir } from "./test-utils.ts";
import { DEFAULT_AGENT_NAME } from "./stella/agents.ts";
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

Deno.test("stella availability: no machine attached reports its own reason", async () => {
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

Deno.test("stella availability: a stopped machine is still usable", async () => {
  // This is the point of starting on demand: podman missing is fatal, a
  // stopped container is not (the first message starts it).
  const core = await stellaCore({
    state: "stopped",
    vncPort: null,
    reason: "",
  });
  try {
    assertEquals(await core.getStellaAvailability(), { available: true });
  } finally {
    await core.close();
  }
});

Deno.test("stella availability: podman missing is not", async () => {
  const core = await stellaCore(NO_PODMAN);
  try {
    const availability = await core.getStellaAvailability();
    assertEquals(availability.available, false);
    if (!availability.available) {
      assert(availability.reason.includes("podman"), availability.reason);
    }
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: the starter agent exists once and is the default", async () => {
  const core = await stellaCore(RUNNING);
  try {
    assertEquals(core.listStellaAgents(), []);
    const starter = core.ensureStellaAgent();
    // A name and a role: the agent's prompt is built from them, so neither
    // may be blank.
    assert(starter.name.length > 0, starter.name);
    assert(starter.role.length > 0, starter.role);
    // A second call returns the same row (the list is the check).
    assertEquals(core.ensureStellaAgent().id, starter.id);
    assertEquals(core.listStellaAgents().map((a) => a.id), [starter.id]);
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: a user's own agent is never replaced by the starter", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const mine = core.createStellaAgent({ name: "Mine", role: "My work." });
    assertEquals(core.ensureStellaAgent().id, mine.id);
    assertEquals(core.listStellaAgents().length, 1);
  } finally {
    await core.close();
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

    const first = await core.updateStellaAgent(agent.id, {
      icon: { bytes: MINI_PNG, extension: ".png" },
    });
    assertEquals(first.icon, core.getStellaAgent(agent.id)?.icon);
    const firstFile = await core.resolveStellaAgentIcon(agent.id, first.icon);
    assertEquals(firstFile?.mimeType, "image/png");

    // Replacing writes a new file and drops the one it replaced: an icon URL
    // is cacheable forever, so the name has to change with the picture.
    const second = await core.updateStellaAgent(agent.id, {
      icon: { bytes: MINI_PNG, extension: ".png" },
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
    const cleared = await core.updateStellaAgent(agent.id, { icon: null });
    assertEquals(cleared.icon, "");
    assertEquals(
      await core.resolveStellaAgentIcon(agent.id, second.icon),
      undefined,
    );
    // Clearing twice is a no-op, not a failure.
    assertEquals(
      (await core.updateStellaAgent(agent.id, { icon: null })).icon,
      "",
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: deleting an agent drops its icon files", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({ name: "Gone", role: "r" });
    const withIcon = await core.updateStellaAgent(agent.id, {
      icon: { bytes: MINI_PNG, extension: ".png" },
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

Deno.test("stella agents: a patch for a missing agent is refused", async () => {
  const core = await stellaCore(RUNNING);
  try {
    // The user deleted the agent while the picture was being saved.
    await assertRejects(
      () =>
        core.updateStellaAgent("gone", {
          icon: { bytes: MINI_PNG, extension: ".png" },
        }),
      CoreError,
      "Agent not found",
    );
    await assertRejects(
      () => core.updateStellaAgent("gone", { icon: null }),
      CoreError,
      "Agent not found",
    );
    await assertRejects(
      () => core.updateStellaAgent("gone", { name: "New" }),
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
        core.updateStellaAgent(agent.id, {
          icon: {
            bytes: new TextEncoder().encode("<html></html>"),
            extension: ".png",
          },
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

Deno.test("stella agents: a rename is checked like a creation", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const first = core.createStellaAgent({ name: "First", role: "r" });
    core.createStellaAgent({ name: "Second", role: "r" });

    // The sidebar's rule is the same in both directions: two rows the user
    // cannot tell apart (compared case-insensitively).
    const taken = await assertRejects(
      () => core.updateStellaAgent(first.id, { name: "second" }),
      CoreError,
    );
    assertEquals(taken.kind, "conflict");
    assertEquals(core.getStellaAgent(first.id)?.name, "First");

    // Keeping one's own name is not a conflict with itself, however it is
    // capitalized: the dialog saves a name on every submit, and a user who
    // only changed the picture must not be refused.
    assertEquals(
      (await core.updateStellaAgent(first.id, { name: "FIRST" })).name,
      "FIRST",
    );

    // An empty name is refused rather than replaced by the default: clearing
    // the field is not a request to be called "Agent".
    const empty = await assertRejects(
      () => core.updateStellaAgent(first.id, { name: "   " }),
      Error,
    );
    assert(empty.message.includes("must not be empty"), empty.message);
    assertEquals(core.getStellaAgent(first.id)?.name, "FIRST");
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: a name and a picture land together", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({ name: "Old", role: "r" });
    const updated = await core.updateStellaAgent(agent.id, {
      name: "New",
      icon: { bytes: MINI_PNG, extension: ".png" },
    });
    assertEquals(updated.name, "New");
    assert(updated.icon !== "", "the picture was not recorded");
    assertEquals(core.getStellaAgent(agent.id)?.name, "New");

    // A refused name costs nothing: the picture must not be written for a
    // patch that does not happen (the dialog saves both, so half of it would
    // look like the save worked).
    const refused = await assertRejects(
      () =>
        core.updateStellaAgent(agent.id, {
          name: " ",
          icon: { bytes: MINI_PNG, extension: ".png" },
        }),
      Error,
    );
    assert(refused.message.includes("must not be empty"), refused.message);
    assertEquals(core.getStellaAgent(agent.id)?.icon, updated.icon);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: its system prompt is the machine's, not the name", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const agent = core.createStellaAgent({
      name: "Aide",
      role: "You keep notes and check facts.",
    });
    const session = await core.getOrCreateStellaSession(agent.id);
    const prompt = session.systemPrompt ?? "";
    // The name is a LABEL the user can change at any time, so it is not in
    // the prompt: a snapshot would either freeze the old one (the agent
    // introducing itself under a name the user already replaced) or cost the
    // provider's cached prefix on every rename.
    assertEquals(prompt.includes("Aide"), false, prompt.slice(0, 200));
    // What it IS told: the opening line every stella conversation shares,
    // and the role the user wrote for this agent.
    assert(
      prompt.startsWith("You are a helpful assistant."),
      prompt.slice(0, 120),
    );
    assert(
      prompt.includes("You keep notes and check facts."),
      prompt.slice(0, 300),
    );
    // The machine framing, not the folder-less chat one.
    assert(
      prompt.includes("inside a Linux desktop"),
      `prompt: ${prompt.slice(0, 200)}`,
    );
    assert(prompt.includes("/home/agent"), prompt.slice(0, 400));
    // And it is not told it cannot run anything (the chat prompt's opening).
    assert(
      !prompt.includes("running without a file workspace"),
      prompt.slice(0, 200),
    );
    // Root inside the machine is part of the machine: the agent is told its
    // account and that sudo needs no password. A prompt that stayed silent
    // would leave it assuming it cannot install anything.
    assert(prompt.includes("`agent`"), prompt.slice(0, 800));
    assert(prompt.includes("sudo"), prompt.slice(0, 800));
    assert(
      prompt.includes("passwordless"),
      `the prompt must say sudo needs no password: ${prompt.slice(0, 800)}`,
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: an agent without a role still gets the opening line", async () => {
  const core = await stellaCore(RUNNING);
  try {
    // The create form's role is optional, so this is a normal agent: it gets
    // the shared opening line and nothing after it on that line (no dangling
    // space, no empty quotation marks).
    const agent = core.createStellaAgent({ name: "Quiet", role: "" });
    const session = await core.getOrCreateStellaSession(agent.id);
    const prompt = session.systemPrompt ?? "";
    assert(
      prompt.startsWith("You are a helpful assistant.\n"),
      JSON.stringify(prompt.slice(0, 60)),
    );
    assertEquals(prompt.includes("Quiet"), false, prompt.slice(0, 120));
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
    skills: () => [],
    screen: createVmTools({ screen }),
    history: createHistorySearchTool({ entries: () => [] }),
    sendChat: {
      store: new SessionAttachmentStore(
        Deno.makeTempDirSync({ prefix: "lumisca-stella-attach-" }),
      ),
      sessionId: "s1",
    },
  });
  const names = tools.map((tool) => tool.name);
  // The coding tools are there: the file surface and the shell.
  for (const expected of ["read", "write", "edit", "list_dir", "bash"]) {
    assert(
      names.includes(expected),
      `missing ${expected}: ${names.join(", ")}`,
    );
  }
  // Searching is the shell's job (the same rule code mode follows), so
  // there are no dedicated search tools to learn.
  for (const gone of ["grep", "glob"]) {
    assertEquals(
      names.includes(gone),
      false,
      `${gone} must not exist at all`,
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
  // visual and chat_attach are gone: the conversation's only channel is
  // send_chat, which carries the words, a card and files in one call. An
  // image goes with the message rather than being published and linked.
  assertEquals(names.includes("visual"), false);
  assertEquals(names.includes("chat_attach"), false);
  assertEquals(names.includes("chat_ui"), false);
  assert(names.includes("send_chat"), names.join(", "));
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
    skills: () => [],
    screen: createVmTools({ screen }),
    history: createHistorySearchTool({ entries: () => [] }),
    sendChat: {
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
    // A tool whose whole contract is its description. The prompt repeats
    // nothing of it: an agent reads the description whenever it decides.
    "read",
    "write",
    "edit",
    "list_dir",
    "bash",
    "async_bash",
    "async_bash_status",
    "async_bash_kill",
    "skill",
    "send_chat",
    "history_search",
    "web_search",
    "web_fetch",
    "task",
    "task_output",
    "send_message",
    "vm_do",
    "vm_wait",
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
      "send_chat",
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
    // Preloaded for a real stella session — not only for a hand-built tool
    // set. Proved by the call below succeeding: the prompt no longer names
    // its tools (see system-prompt.ts), so the transcript cannot show it.

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

Deno.test("stella conversation: a run that says nothing leaves nothing on screen", async () => {
  // Silence is the deliberate act. The default is that a turn's text is the
  // reply (see the next test), so a run that has nothing to add writes the
  // sentinel instead of relying on a forgotten `send_chat` to hide it.
  const { faux, core, session } = await stellaConversation("Quiet");
  try {
    faux.setResponses([fauxAssistantMessage(NO_RESPONSE)]);
    await promptSession(core, session.id, "定期チェックを実行して");

    const page = core.readStellaConversation(session.id, {})!;
    // The prompt is there; the sentinel is not a message.
    assertEquals(page.items.map((entry) => entry.role), ["user"]);
    assertEquals(page.items[0]?.text, "定期チェックを実行して");

    // It IS in the model's history: the notes are what the model reasons
    // with, and dropping them would make the next turn amnesiac.
    assert(
      core.getAgent(session.id)!.messages.some((message) =>
        message.role === "assistant"
      ),
      "the agent's own turn stays in its history",
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: the agent's reply is what the store serves", async () => {
  // The regression this pins: the live stream projected the assistant's text
  // (see stella-stream.ts), but the store's conversation scope still selected
  // only prompts and `send_chat` results. A reply was on screen until the next
  // snapshot — a reload, a reconnect, a window opened again — and then gone,
  // while the prompts remained. The stream and the store must draw the same
  // conversation.
  const { faux, core, session, agent } = await stellaConversation("Answerer");
  try {
    faux.setResponses([fauxAssistantMessage("了解しました。進めます。")]);
    await promptSession(core, session.id, "お願いします");

    // The newest window of the conversation, as a client re-opening it reads.
    const page = core.readStellaConversation(session.id, {})!;
    assertEquals(
      page.items.map((entry) => [entry.role, entry.text]),
      [
        ["user", "お願いします"],
        ["assistant", "了解しました。進めます。"],
      ],
    );

    // The sidebar's second line is the same projection: the newest thing the
    // conversation shows is the reply, not the prompt before it.
    const row = core.listStellaAgentSummaries().find((item) =>
      item.id === agent.id
    );
    assertEquals(row?.preview?.kind, "text");
    if (row?.preview?.kind !== "text") throw new Error("unreachable");
    assertEquals(row.preview.text, "了解しました。進めます。");
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: what send_chat sends is the conversation", async () => {
  const { faux, core, session } = await stellaConversation("Aide");
  try {
    const markup = '<Card title="確認"><Text>進めますか。</Text></Card>';
    faux.setResponses([
      fauxAssistantMessage([
        // The working notes: never shown.
        { type: "text", text: "まず報告を送ろう。" },
        fauxToolCall("send_chat", {
          text: "3件の不具合を直しました。",
          card: markup,
        }, "call-1"),
      ], { stopReason: "toolUse" }),
      // A second turn that has nothing to add: silence, spelled out.
      fauxAssistantMessage(NO_RESPONSE),
    ]);
    await promptSession(core, session.id, "直して");

    const page = core.readStellaConversation(session.id, {})!;
    const entries = page.items;
    assertEquals(entries.map((entry) => entry.role), ["user", "assistant"]);
    const sent = entries[1]!;
    assertEquals(sent.text, "3件の不具合を直しました。");
    assertEquals(sent.card, markup);
    assertEquals(sent.attachments, []);

    // The words also went nowhere near the tool's model-facing result: a
    // message is in the transcript once (as the call's arguments), and the
    // receipt is all the model reads back.
    const result = core.getAgent(session.id)!.messages.find((message) =>
      message.role === "toolResult" && message.toolName === "send_chat"
    );
    assert(result !== undefined, "send_chat must have run");
    if (result.role !== "toolResult") throw new Error("unreachable");
    const receipt = result.content
      .map((block) => block.type === "text" ? block.text : "")
      .join("");
    assertEquals(receipt.includes("3件の不具合を直しました。"), false, receipt);
    assert(receipt.includes("Sent"), receipt);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: a tool-heavy run still shows the conversation", async () => {
  // The screen draws entries, not rows. A page that counted raw rows filled
  // up on the tool traffic of one run and projected to zero entries, and the
  // newest window then answered "empty, with nothing before it" — during a
  // run, exactly when the dots are showing. The client could never recover:
  // every resync asked for the same window and got the same nothing, so
  // looking away from a working agent and back left the conversation blank.
  const { faux, core, session } = await stellaConversation("Surveyor");
  try {
    // A prompt, then one turn that runs more tools than a page holds rows.
    faux.setResponses([
      fauxAssistantMessage("まず調べます。"),
    ]);
    await promptSession(core, session.id, "調べて");

    const responses = [];
    for (let i = 0; i < 25; i++) {
      responses.push(
        fauxAssistantMessage(
          [fauxToolCall("history_search", { query: `probe-${i}` })],
          { stopReason: "toolUse" },
        ),
      );
    }
    responses.push(fauxAssistantMessage("done"));
    faux.setResponses(responses);
    await promptSession(core, session.id, "詳しく");

    const page = core.readStellaConversation(session.id, {})!;
    // Both exchanges are in the newest window — the page counts entries, so
    // the 25 tool rows between them cannot crowd the conversation out of it.
    assertEquals(
      page.items.map((entry) => [entry.role, entry.text]),
      [
        ["user", "調べて"],
        ["assistant", "まず調べます。"],
        ["user", "詳しく"],
        ["assistant", "done"],
      ],
    );
    // The conversation's beginning is not behind the window, so the walk
    // ends here.
    assertEquals(page.older, null);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: a long conversation pages back by entries", async () => {
  // The way back has to be measured in the same units as the page: a cursor
  // resolved against every row would land somewhere other than the entry it
  // names, and the reader would be handed a window that repeats or skips.
  const { faux, core, session } = await stellaConversation("Archivist");
  try {
    const responses = [];
    for (let i = 0; i < 3; i++) {
      responses.push(
        fauxAssistantMessage(
          [fauxToolCall("send_chat", { text: `message ${i}` }, `call-${i}`)],
          { stopReason: "toolUse" },
        ),
      );
      responses.push(fauxAssistantMessage("sent"));
    }
    faux.setResponses(responses);
    for (let i = 0; i < 3; i++) {
      await promptSession(core, session.id, `prompt ${i}`);
    }

    // Walk back the way a reader does: each page names the one before it,
    // and the pages together are the conversation, in order and without a
    // repeat or a skip. A turn holds three entries (the prompt, what was
    // sent, and the final reply), so a page of two cuts inside a turn.
    const collected: string[] = [];
    let older: string | null = null;
    for (let pages = 0; pages < 20; pages++) {
      const page: WindowPage<StellaEntry> = core.readStellaConversation(
        session.id,
        {
          limit: 2,
          ...(older === null ? {} : { older }),
        },
      )!;
      assert(page.items.length <= 2, `page ${pages} exceeded its size`);
      collected.unshift(...page.items.map((entry) => entry.text));
      older = page.older;
      if (older === null) break;
    }
    // Read in entries, the walk ends exactly at the conversation's beginning.
    assertEquals(older, null);
    assertEquals(collected, [
      "prompt 0",
      "message 0",
      "sent",
      "prompt 1",
      "message 1",
      "sent",
      "prompt 2",
      "message 2",
      "sent",
    ]);
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: history_search reads the message after a prune", async () => {
  // A checkpoint replaces the span that held the call (whose arguments carry
  // the words), so the send_chat ROW is what keeps the message readable —
  // that is why prune keeps it.
  const { faux, core, session } = await stellaConversation("Scribe");
  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("send_chat", {
          text: "見積もりは 42 万円です。",
        }, "call-1"),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("送りました。"),
    ]);
    await promptSession(core, session.id, "見積もりを出して");

    // A later search finds it (the same conversation, read back by words).
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("history_search", { query: "見積もり" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("思い出しました。"),
    ]);
    await promptSession(core, session.id, "さっきの見積もりは？");
    const text = lastHistoryResult(core, session.id);
    assert(text.includes("見積もりは 42 万円です。"), text);
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
    const skills = core.listStellaSkills(agent.id);
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

Deno.test("stella conversation: two agents do not share their own skills", async () => {
  const faux = fauxProvider();
  // The machine answers per directory: each agent's own folder and the
  // machine-wide folder hold different lists, which is what makes a
  // per-agent catalog observable here.
  const byDir = new Map<string, Array<{ name: string; description: string }>>();
  const core = LumiscaCore.forTesting(
    [faux.provider],
    () => ({}),
    {
      run: (command: readonly string[]) => {
        const stdout = command.join(" ").includes(".agents/skills")
          ? listingOf(byDir.get(command[command.length - 1] ?? "") ?? [])
          : "";
        return Promise.resolve({
          exitCode: 0,
          stdout,
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
    },
  );
  core.models.models.setProvider(faux.provider);
  await core.setProviderApiKey(faux.provider.id, "faux-key");
  core.setStellaVm(fakeVm(RUNNING));
  try {
    const first = core.createStellaAgent({ name: "First", role: "One." });
    const second = core.createStellaAgent({ name: "Second", role: "Two." });
    byDir.set(`/home/agent/agents/${first.id}/.agents/skills`, [{
      name: "only-for-first",
      description: "First's own skill.",
    }]);
    byDir.set("/home/agent/.agents/skills", [{
      name: "for-everyone",
      description: "The machine-wide skill.",
    }]);

    const sessionA = await core.getOrCreateStellaSession(first.id);
    await core.getOrCreateStellaSession(second.id);

    const namesA = core.listStellaSkills(first.id).map((s) => s.name);
    const namesB = core.listStellaSkills(second.id).map((s) => s.name);
    // Each agent sees its own skill and the machine-wide one...
    assert(namesA.includes("only-for-first"), JSON.stringify(namesA));
    assert(namesA.includes("for-everyone"), JSON.stringify(namesA));
    assert(namesB.includes("for-everyone"), JSON.stringify(namesB));
    // ...and not the other agent's.
    assertEquals(
      namesB.includes("only-for-first"),
      false,
      JSON.stringify(namesB),
    );
    // The machine has file tools, so the guide that teaches writing a skill
    // is advertised (unlike a chat session, which cannot write one).
    assert(namesA.includes("skill-authoring"), JSON.stringify(namesA));

    // The catalog the model reads is the same per-agent list.
    faux.setResponses([fauxAssistantMessage("ok")]);
    await promptSession(core, sessionA.id, "what can you do?");
    const published = core.getAgent(sessionA.id)!.messages.find((message) =>
      message.role === "context" && message.provider === "skills"
    );
    assert(published !== undefined, "the skill catalog must be published");
    if (published.role !== "context") throw new Error("unreachable");
    assert(published.body.includes("only-for-first"), published.body);
    assert(published.body.includes("for-everyone"), published.body);
  } finally {
    await core.close();
  }
});

/** The listing of one skills folder as `scanVmSkillsDir` asks for it. */
function listingOf(
  skills: Array<{ name: string; description: string }>,
): string {
  return skills
    .map((skill) =>
      `\n__SKILL__${skill.name}\n---\nname: ${skill.name}\n` +
      `description: ${skill.description}\n---\n\nBody.\n`
    )
    .join("");
}

Deno.test("stella agents: an unnamed agent gets a free default name", async () => {
  const core = await stellaCore(RUNNING);
  try {
    // The user did not fill the form in. Creating must still work, and the
    // second unnamed agent must not be refused as "that name is taken" for a
    // name the user never wrote.
    const first = core.createStellaAgent({ name: "", role: "" });
    assertEquals(first.name, DEFAULT_AGENT_NAME);
    assertEquals(first.role, "");

    const second = core.createStellaAgent({ name: "   ", role: "" });
    assertEquals(second.name, `${DEFAULT_AGENT_NAME} 2`);

    // A name the user DID write keeps the duplicate rule.
    core.createStellaAgent({ name: "Notes", role: "" });
    assertThrows(
      () => core.createStellaAgent({ name: "Notes", role: "" }),
      Error,
    );
    assertThrows(
      () => core.createStellaAgent({ name: "notes", role: "" }),
      Error,
    );
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: only stella sessions condense an idle history", async () => {
  // stella's conversation is the one that lives for weeks: it is reopened
  // after hours or days of silence, so the period is set there and nowhere
  // else (a working session the user closed is reopened on purpose, and the
  // pressure check covers it).
  const { core, session } = await stellaConversation("Idle");
  try {
    const agent = core.getAgent(session.id)!;
    assertEquals(agent.idleCompaction, {
      afterMs: 30 * 60 * 1000,
      minTokens: 50_000,
      keepTokens: 20_000,
    });

    // Every other session keeps the pressure check alone.
    await withTempDir("lumisca-idle-", async (root) => {
      const workspace = await core.createWorkspace("ws", [root]);
      const plain = await core.createSession({ workspaceId: workspace.id });
      assertEquals(core.getAgent(plain.id)!.idleCompaction, null);
    });
  } finally {
    await core.close();
  }
});

Deno.test("stella conversation: only stella sessions drop what a checkpoint covered", async () => {
  // The transcript of a conversation that lives for years holds the work as
  // well as the talk. stella's clients never receive the work rows and its
  // history_search searches the conversation's entries, so the rows behind a
  // checkpoint are reduced to markers. Code mode's work log IS a surface, so
  // its rows are left as they are.
  const { core, session } = await stellaConversation("Prune");
  try {
    assertStellaPrunes(core, session.id, true);
    await withTempDir("lumisca-prune-", async (root) => {
      const workspace = await core.createWorkspace("ws", [root]);
      const plain = await core.createSession({ workspaceId: workspace.id });
      assertStellaPrunes(core, plain.id, false);
    });
  } finally {
    await core.close();
  }
});

/** Assert whether the agent of `sessionId` reduces condensed rows, by
 * checking the option it was built with through a compaction. */
function assertStellaPrunes(
  core: LumiscaCore,
  sessionId: string,
  expected: boolean,
): void {
  const agent = core.getAgent(sessionId)!;
  // The option is what the compaction hook consults; reading it through the
  // public surface would need a run, and a run here would test the
  // compaction rather than the wiring.
  assertEquals(
    (agent as unknown as { pruneCondensed: boolean }).pruneCondensed,
    expected,
  );
}

Deno.test("stella agents: a row says what its conversation last said", async () => {
  const { faux, core, agent, session } = await stellaConversation("Aide");
  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("send_chat", {
          text: "3件の不具合を直しました。",
        }, "call-1"),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(NO_RESPONSE),
    ]);
    await promptSession(core, session.id, "直して");

    const rows = core.listStellaAgentSummaries();
    const row = rows.find((item) => item.id === agent.id);
    assert(row !== undefined, "the agent must be in the list");
    // The newest thing the conversation shows: what the agent SENT. The
    // second turn has nothing to add and says so with the sentinel, so it
    // does not become a preview of its own.
    assertEquals(row.preview, {
      kind: "text",
      text: "3件の不具合を直しました。",
      at: row.preview!.at,
    });
    // The time it carries is the message's, which is also what the list
    // orders by.
    assertEquals(row.preview!.at > 0, true);

    // An agent whose conversation was never opened says nothing: nothing has
    // been said in it, and a row must not invent a line.
    const quiet = core.createStellaAgent({ name: "Quiet", role: "r" });
    const quietRow = core.listStellaAgentSummaries().find((item) =>
      item.id === quiet.id
    );
    assertEquals(quietRow?.preview, null);
  } finally {
    await core.close();
  }
});

Deno.test("stella agents: the preview is the newest entry, not the newest row", async () => {
  // The newest rows are tool traffic and a silent turn — none of which the
  // conversation shows; the entry before them is what the sidebar must say.
  const { faux, core, agent, session } = await stellaConversation("Aide");
  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("send_chat", { text: "一行目" }, "call-1"),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo hi" }, "call-2"),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(NO_RESPONSE),
    ]);
    await promptSession(core, session.id, "やって");

    const row = core.listStellaAgentSummaries().find((item) =>
      item.id === agent.id
    );
    assertEquals(row?.preview?.kind, "text");
    if (row?.preview?.kind !== "text") throw new Error("unreachable");
    assertEquals(row.preview.text, "一行目");
  } finally {
    await core.close();
  }
});

Deno.test("stella prompt: the reply is the message, silence is asked for", async () => {
  // The rule the model has to follow. It is the opposite of the rule this
  // prompt used to carry: the agent's own text IS what the user reads, and a
  // run that wants to say nothing writes the sentinel. A forgotten decision
  // therefore produces a message rather than an unanswered question.
  const { buildStellaSystemPrompt } = await import("./tools/system-prompt.ts");
  const prompt = buildStellaSystemPrompt({ tools: ["read", "send_chat"] });
  assert(prompt.includes("Your reply is the message"), prompt);
  assert(prompt.includes("replies with exactly NO_RESPONSE"), prompt);
  // …and the tool is described as the second channel, not the first.
  assert(prompt.includes("send_chat carries what a reply cannot"), prompt);
});
