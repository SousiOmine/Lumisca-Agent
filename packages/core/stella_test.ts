import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fauxProvider } from "./ai/faux.ts";
import { LumiscaCore } from "./core.ts";
import type { VmManager, VmStatus } from "./vm/container.ts";
import { createStellaTools } from "./tools/toolsets.ts";
import { hostBackends } from "./tools/toolsets.ts";
import { createVmTools } from "./vm/tools.ts";
import type { VmScreen } from "./vm/screen.ts";
import { CoreError } from "./errors.ts";
import { APP_MODE_KEY } from "./shared/settings-keys.ts";

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
    reset: () => Promise.resolve({ ...status, state: "running" as const }),
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

Deno.test("app mode: switching to stella is refused without a usable machine", async () => {
  const core = await stellaCore(NO_PODMAN);
  try {
    const availability = await core.getStellaAvailability();
    assertEquals(availability.available, false);
    const error = assertThrows(
      () => core.setAppMode("stella"),
      CoreError,
    );
    assert(
      error.message.includes("podman"),
      `the reason must name podman: ${error.message}`,
    );
    // The stored mode is unchanged: a refused switch leaves the old one.
    assertEquals(core.getAppMode(), undefined);
  } finally {
    void core.close();
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

Deno.test("stella conversation: its system prompt is the machine's", async () => {
  const core = await stellaCore(RUNNING);
  try {
    const session = await core.getOrCreateStellaSession();
    const prompt = session.systemPrompt ?? "";
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
  void faux;
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
  // A session without them gets no such guidance (the sections are
  // tool-gated, like every other section).
  const without = buildStellaSystemPrompt({ tools: ["read", "bash"] });
  assert(!without.includes("vm_screenshot"), without);
});
