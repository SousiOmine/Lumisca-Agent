import { assertEquals, assertRejects } from "@std/assert";
import type { VmCommandBytesRunner, VmCommandRunner } from "./command.ts";
import type { VmManager, VmStatus } from "./container.ts";
import {
  VM_DESKTOP_SLOTS,
  VM_DISPLAY,
  VM_VNC_PORT,
  VM_VNC_PORT_RANGE,
  VM_VNC_RFB_PORT,
  vmBusAddressOf,
  vmBusSocketOf,
  vmDisplayOf,
  vmWebsockifyPortOf,
} from "./contract.ts";
import { StellaMachine } from "./machine.ts";

/**
 * One desktop per agent.
 *
 * The machine gives every agent its own X server, session bus, browser
 * profile and VNC bridge so two conversations cannot share a tab, a login, a
 * pointer or an accessibility tree (see issue #44). These tests pin the parts
 * that can be checked without a container: the numbering, which slot a
 * session's tools end up on, and that a machine which restarted is asked to
 * start its desktops again.
 */

/** A manager that records desktop starts and stops, and answers a port per
 * slot. Only the methods StellaMachine calls are needed. */
function fakeManager(): {
  manager: VmManager;
  started: { slot: number; agentId: string }[];
  stopped: number[];
  /** What `status` reports, and what `stop` leaves behind. */
  state: { value: VmStatus };
  starts: () => number;
} {
  const started: { slot: number; agentId: string }[] = [];
  const stopped: number[] = [];
  const state = { value: RUNNING };
  let starts = 0;
  const manager: VmManager = {
    status: () => Promise.resolve(state.value),
    start: () => {
      starts += 1;
      state.value = RUNNING;
      return Promise.resolve(state.value);
    },
    stop: () => {
      state.value = { state: "stopped", vncPort: null, reason: "" };
      return Promise.resolve();
    },
    startDesktop: async (slot, agentId) => {
      // A real start is a process away; suspending here is what makes the
      // concurrent case below possible at all.
      await Promise.resolve();
      started.push({ slot, agentId });
    },
    stopDesktop: async (slot) => {
      stopped.push(slot);
    },
    vncPort: async (slot = 0) => 49152 + slot,
  };
  return { manager, started, stopped, state, starts: () => starts };
}

const RUNNING: VmStatus = { state: "running", vncPort: 49153, reason: "" };

/** The command runner the exec seams are built over: it records what would
 * have gone to podman and answers an empty success. */
function recorder(): {
  run: VmCommandRunner;
  runBytes: VmCommandBytesRunner;
  calls: { command: readonly string[] }[];
} {
  const calls: { command: readonly string[] }[] = [];
  const result = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  } as never;
  return {
    calls,
    run: async (command) => {
      calls.push({ command });
      return result;
    },
    runBytes: async () => result,
  };
}

function machine(
  options: {
    /** Which agents' conversations are working (default: none). */
    busy?: (agentId: string) => boolean;
    desktopWaitMs?: number;
  } = {},
): {
  stella: StellaMachine;
  manager: ReturnType<typeof fakeManager>;
  calls: { command: readonly string[] }[];
} {
  const manager = fakeManager();
  const run = recorder();
  const stella = new StellaMachine(
    undefined,
    { run: run.run, runBytes: run.runBytes },
    options.desktopWaitMs === undefined
      ? {}
      : { desktopWaitMs: options.desktopWaitMs },
  );
  stella.setBusyCheck(options.busy ?? (() => false));
  stella.set(manager.manager);
  return { stella, manager, calls: run.calls };
}

/** Every slot's agent, named in the order they are started. */
function agents(): string[] {
  return Array.from({ length: VM_DESKTOP_SLOTS }, (_, i) => `agent-${i}`);
}

Deno.test("desktop slots have their own display, ports and session bus", () => {
  // :99 is the machine's own screen; the desktops start above it, so a
  // program started outside a desktop never lands on an agent's screen.
  assertEquals(VM_DISPLAY, ":99");
  assertEquals(vmDisplayOf(0), ":100");
  assertEquals(vmDisplayOf(1), ":101");
  assertEquals(vmDisplayOf(VM_DESKTOP_SLOTS - 1), `:${99 + VM_DESKTOP_SLOTS}`);
  // Every slot's websockify is published, so the relay can find any of them.
  assertEquals(vmWebsockifyPortOf(0), VM_VNC_PORT);
  assertEquals(
    vmWebsockifyPortOf(VM_DESKTOP_SLOTS - 1),
    VM_VNC_PORT + VM_DESKTOP_SLOTS - 1,
  );
  assertEquals(
    VM_VNC_PORT_RANGE,
    `${VM_VNC_PORT}-${VM_VNC_PORT + VM_DESKTOP_SLOTS - 1}`,
  );
  // Each desktop has its own accessibility tree, reached through its own bus.
  assertEquals(vmBusSocketOf(0), "/tmp/lumisca-dbus/session-0.sock");
  assertEquals(vmBusSocketOf(1) === vmBusSocketOf(0), false);
  assertEquals(vmBusAddressOf(1), "unix:path=/tmp/lumisca-dbus/session-1.sock");
  assertEquals(VM_VNC_RFB_PORT, 5900);
});

Deno.test("exec: the first call starts the agent's desktop and carries its display and bus", async () => {
  const { stella, manager, calls } = machine();
  const exec = stella.execFor("agent-a");
  await exec!(["true"], { timeoutMs: 1000 });
  await exec!(["true"], { timeoutMs: 1000 });
  // One desktop for two calls: the slot is taken once.
  assertEquals(manager.started, [{ slot: 0, agentId: "agent-a" }]);
  for (const call of calls) {
    assertEquals(call.command.includes("DISPLAY=:100"), true);
    assertEquals(
      call.command.includes(
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/lumisca-dbus/session-0.sock",
      ),
      true,
    );
  }
});

Deno.test("exec: a second agent gets the next slot and its own display", async () => {
  const { stella, manager, calls } = machine();
  await stella.execFor("agent-a")!(["true"], { timeoutMs: 1000 });
  await stella.execFor("agent-b")!(["true"], { timeoutMs: 1000 });
  assertEquals(manager.started, [
    { slot: 0, agentId: "agent-a" },
    { slot: 1, agentId: "agent-b" },
  ]);
  assertEquals(calls[1]!.command.includes("DISPLAY=:101"), true);
  assertEquals(
    calls[1]!.command.includes(
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/lumisca-dbus/session-1.sock",
    ),
    true,
  );
});

Deno.test("exec: two agents that start at once get different slots", async () => {
  // Two conversations can use their screens in the same turn. Reserving the
  // slot has to happen before the start is awaited, or both read the same
  // free slot and one of them works in the other's browser.
  const { stella, manager } = machine();
  const [a, b] = await Promise.all([
    stella.desktopFor("agent-a"),
    stella.desktopFor("agent-b"),
  ]);
  assertEquals(a === b, false);
  assertEquals(manager.started.length, 2);
  assertEquals(new Set(manager.started.map((start) => start.slot)).size, 2);
  assertEquals(
    new Set(manager.started.map((start) => start.agentId)),
    new Set(["agent-a", "agent-b"]),
  );
});

Deno.test("exec: the next agent takes the idle desktop used least recently", async () => {
  const { stella, manager } = machine();
  for (const agent of agents()) {
    await stella.execFor(agent)!(["true"], { timeoutMs: 1000 });
  }
  // Touch the second one so the first is the least recently used.
  await stella.execFor("agent-1")!(["true"], { timeoutMs: 1000 });
  await stella.execFor("extra")!(["true"], { timeoutMs: 1000 });
  assertEquals(manager.stopped, [0]);
  assertEquals(manager.started.at(-1), { slot: 0, agentId: "extra" });
});

Deno.test("exec: a working conversation's desktop is never taken", async () => {
  // Taking a desktop from a run in progress kills its browser under it. The
  // next agent must take another idle desktop instead, even though this one
  // is the least recently used.
  const busy = new Set<string>();
  const { stella, manager } = machine({ busy: (id) => busy.has(id) });
  for (const agent of agents()) {
    await stella.desktopFor(agent);
  }
  busy.add("agent-0");
  const slot = await stella.desktopFor("extra");
  assertEquals(slot, 1);
  assertEquals(manager.stopped, [1]);
});

Deno.test("exec: a request waits for a slot instead of interrupting a run", async () => {
  const busy = new Set<string>();
  const { stella, manager } = machine({
    busy: (id) => busy.has(id),
    desktopWaitMs: 5_000,
  });
  for (const agent of agents()) {
    await stella.desktopFor(agent);
    busy.add(agent);
  }
  // Nobody can give way yet. The request waits, and the run that ends first
  // frees its desktop for it.
  const waiting = stella.desktopFor("extra");
  setTimeout(() => busy.delete("agent-3"), 100);
  assertEquals(await waiting, 3);
  assertEquals(manager.stopped, [3]);
});

Deno.test("exec: when every conversation is working, the request fails with a reason", async () => {
  // The machine cannot tell a run that ended from one that never started: it
  // may only ask. Guessing would take a desktop from a run, so the request is
  // refused instead, with a sentence the agent can act on.
  const { stella } = machine({ busy: () => true, desktopWaitMs: 30 });
  for (const agent of agents()) {
    await stella.desktopFor(agent);
  }
  await assertRejects(
    () => stella.desktopFor("extra"),
    Error,
    "desktops are in use",
  );
});

Deno.test("a stopped machine's agents start their desktops again", async () => {
  // `podman stop` ends every process in the container, desktops included.
  // Remembering the slots across that would leave an agent with a display
  // nothing is running on.
  const { stella, manager } = machine();
  await stella.desktopFor("agent-a");
  await stella.stop();
  await stella.desktopFor("agent-a");
  assertEquals(manager.started, [
    { slot: 0, agentId: "agent-a" },
    { slot: 0, agentId: "agent-a" },
  ]);
});

Deno.test("a machine that restarted before a send starts its desktops again", async () => {
  // The other way a container comes back: the app is still running, the
  // machine was stopped (or crashed) and the next send brings it up.
  const { stella, manager } = machine();
  await stella.desktopFor("agent-a");
  manager.state.value = { state: "stopped", vncPort: null, reason: "" };
  await stella.ensureReady();
  await stella.desktopFor("agent-a");
  assertEquals(manager.started.length, 2);
});

Deno.test("a replaced machine forgets which slot belonged to whom", async () => {
  // A new manager is a new container: nothing is running inside it.
  const { stella, manager } = machine();
  await stella.desktopFor("agent-a");
  stella.set(manager.manager);
  await stella.desktopFor("agent-a");
  assertEquals(manager.started.length, 2);
});

Deno.test("vncPortFor: the screen pane finds the agent's own desktop", async () => {
  const { stella } = machine();
  assertEquals(await stella.vncPortFor("agent-a"), 49152);
  await stella.execFor("agent-b")!(["true"], { timeoutMs: 1000 });
  assertEquals(await stella.vncPortFor("agent-b"), 49153);
  // Asking again does not start a second desktop.
  assertEquals(await stella.vncPortFor("agent-b"), 49153);
});
