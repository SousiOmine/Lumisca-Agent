import { assertEquals } from "@std/assert";
import type { VmCommandBytesRunner, VmCommandRunner } from "./command.ts";
import type { VmManager } from "./container.ts";
import {
  VM_DISPLAY,
  VM_VNC_PORT,
  VM_VNC_PORT_RANGE,
  vmDisplayOf,
  vmProfileDir,
  vmWebsockifyPortOf,
} from "./contract.ts";
import { StellaMachine } from "./machine.ts";

/**
 * One desktop per agent.
 *
 * The machine gives every agent its own X server, browser profile and VNC
 * bridge so two conversations cannot share a tab, a login or a pointer (see
 * issue #44). These tests pin the two halves that can be checked without a
 * container: the numbering, and which slot a session's tools end up on.
 */

/** A manager that records desktop starts and stops, and answers a port per
 * slot. Only the methods StellaMachine's desktop layer calls are needed. */
function fakeManager(): {
  manager: VmManager;
  started: { slot: number; agentId: string }[];
  stopped: number[];
} {
  const started: { slot: number; agentId: string }[] = [];
  const stopped: number[] = [];
  const manager = {
    startDesktop: async (slot: number, agentId: string) => {
      started.push({ slot, agentId });
    },
    stopDesktop: async (slot: number) => {
      stopped.push(slot);
    },
    vncPort: async (slot = 0) => 49152 + slot,
  } as unknown as VmManager;
  return { manager, started, stopped };
}

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

function machine(): {
  stella: StellaMachine;
  manager: ReturnType<typeof fakeManager>;
  calls: { command: readonly string[] }[];
} {
  const manager = fakeManager();
  const run = recorder();
  const stella = new StellaMachine(undefined, {
    run: run.run,
    runBytes: run.runBytes,
  });
  stella.set(manager.manager);
  return { stella, manager, calls: run.calls };
}

Deno.test("desktop slots have their own display and screen port", () => {
  assertEquals(vmDisplayOf(0), VM_DISPLAY);
  assertEquals(vmDisplayOf(1), ":100");
  assertEquals(vmDisplayOf(3), ":102");
  // Every slot's websockify is published, so the relay can find any of them.
  assertEquals(vmWebsockifyPortOf(0), VM_VNC_PORT);
  assertEquals(vmWebsockifyPortOf(3), VM_VNC_PORT + 3);
  assertEquals(VM_VNC_PORT_RANGE, `${VM_VNC_PORT}-${VM_VNC_PORT + 3}`);
  // A profile is the agent's name, so two agents never share logins.
  assertEquals(vmProfileDir("a1").endsWith("/chromium/a1"), true);
  assertEquals(vmProfileDir("a1") === vmProfileDir("b2"), false);
});

Deno.test("exec: the first call starts the agent's desktop and carries its DISPLAY", async () => {
  const { stella, manager, calls } = machine();
  const exec = stella.execFor("agent-a");
  await exec!(["true"], { timeoutMs: 1000 });
  await exec!(["true"], { timeoutMs: 1000 });
  // One desktop for two calls: the slot is taken once.
  assertEquals(manager.started, [{ slot: 0, agentId: "agent-a" }]);
  for (const call of calls) {
    assertEquals(call.command.includes("--env"), true);
    assertEquals(call.command.includes("DISPLAY=:99"), true);
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
  assertEquals(calls[1]!.command.includes("DISPLAY=:100"), true);
});

Deno.test("exec: a fifth agent takes the slot nobody has used for longest", async () => {
  const { stella, manager } = machine();
  for (const agent of ["a", "b", "c", "d"]) {
    await stella.execFor(agent)!(["true"], { timeoutMs: 1000 });
  }
  // Touch b so a is the least recently used.
  await stella.execFor("b")!(["true"], { timeoutMs: 1000 });
  await stella.execFor("e")!(["true"], { timeoutMs: 1000 });
  assertEquals(manager.stopped, [0]);
  assertEquals(manager.started.at(-1), { slot: 0, agentId: "e" });
});

Deno.test("vncPortFor: the screen pane finds the agent's own desktop", async () => {
  const { stella } = machine();
  assertEquals(await stella.vncPortFor("agent-a"), 49152);
  await stella.execFor("agent-b")!(["true"], { timeoutMs: 1000 });
  assertEquals(await stella.vncPortFor("agent-b"), 49153);
  // Asking again does not start a second desktop.
  assertEquals(await stella.vncPortFor("agent-b"), 49153);
});
