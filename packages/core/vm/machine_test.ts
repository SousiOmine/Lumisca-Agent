import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import type { VmCommandBytesRunner, VmCommandRunner } from "./command.ts";
import type { VmHost, VmHostStatus, VmManager, VmStatus } from "./container.ts";
import { VM_WARM_FLOOR, vmContainerName } from "./contract.ts";
import { StellaMachine } from "./machine.ts";
import type { MachineRunners } from "./machine-seams.ts";

/**
 * The machines of stella mode: one container per agent, woken on use and
 * stopped when nobody uses it.
 *
 * These tests pin the parts that can be checked without a container: which
 * machine a session's tools reach, that a wake happens once however many
 * callers race for it, and that an idle machine stops only when it is safe to
 * stop (no run, no background command, no command in flight).
 */

const RUNNING: VmStatus = { state: "running", vncPort: 49153, reason: "" };
const STOPPED: VmStatus = { state: "stopped", vncPort: null, reason: "" };

/** A host whose machines are recorded instead of started. */
function fakeHost(): {
  host: VmHost;
  starts: string[];
  stops: string[];
  desktops: string[];
  desktopStops: number;
  state: Map<string, VmStatus>;
  managers: Map<string, VmManager>;
} {
  const starts: string[] = [];
  const stops: string[] = [];
  const desktops: string[] = [];
  const state = new Map<string, VmStatus>();
  const managers = new Map<string, VmManager>();
  const counters = { desktopStops: 0 };
  const host: VmHost = {
    status: (): Promise<VmHostStatus> =>
      Promise.resolve({ state: "ready", reason: "" }),
    ensureImage: () => Promise.resolve(),
    machine: (agentId) => {
      const known = managers.get(agentId);
      if (known !== undefined) return known;
      const manager: VmManager = {
        status: () => Promise.resolve(state.get(agentId) ?? STOPPED),
        start: () => {
          starts.push(agentId);
          state.set(agentId, RUNNING);
          return Promise.resolve(RUNNING);
        },
        stop: () => {
          stops.push(agentId);
          state.set(agentId, STOPPED);
          return Promise.resolve();
        },
        remove: () => {
          stops.push(agentId);
          state.delete(agentId);
          return Promise.resolve();
        },
        vncPort: () => Promise.resolve(49152),
        startDesktop: () => {
          desktops.push(agentId);
          return Promise.resolve();
        },
        stopDesktop: () => {
          counters.desktopStops += 1;
          return Promise.resolve();
        },
      };
      managers.set(agentId, manager);
      return manager;
    },
    stopAll: async () => {
      for (const agentId of managers.keys()) {
        if ((state.get(agentId) ?? STOPPED).state === "running") {
          stops.push(agentId);
          state.set(agentId, STOPPED);
        }
      }
    },
    retireLegacy: () => Promise.resolve(),
    building: false,
  };
  return {
    host,
    starts,
    stops,
    desktops,
    get desktopStops() {
      return counters.desktopStops;
    },
    state,
    managers,
  };
}

/** The command runner the exec seams are built over: records the argv and
 * answers an empty success. */
function recorder(): {
  run: VmCommandRunner;
  runBytes: VmCommandBytesRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const result = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  } as never;
  return {
    calls,
    run: (command) => {
      calls.push([...command]);
      return Promise.resolve(result);
    },
    runBytes: () => Promise.resolve(result),
  };
}

/** One clock for the idle window: the tests move it by hand instead of
 * waiting five minutes. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function machine(
  options: {
    host?: VmHost;
    busy?: (agentId: string) => boolean;
    idleMs?: number;
    /** Test seam: 0 exercises the idle path with one machine. */
    warmFloor?: number;
    time?: ReturnType<typeof clock>;
    run?: VmCommandRunner;
  } = {},
): {
  stella: StellaMachine;
  fake: ReturnType<typeof fakeHost>;
  calls: string[][];
  time: ReturnType<typeof clock>;
} {
  const fake = options.host === undefined ? fakeHost() : undefined;
  const host = options.host ?? fake!.host;
  const run = recorder();
  const time = options.time ?? clock();
  const stella = new StellaMachine(
    undefined,
    {
      run: options.run ?? run.run,
      runBytes: run.runBytes,
    },
    {
      idleMs: options.idleMs ?? 1_000,
      warmFloor: options.warmFloor ?? VM_WARM_FLOOR,
      now: time.now,
      timer: false,
    },
  );
  stella.setBusyCheck(options.busy ?? (() => false));
  stella.set(host);
  return {
    stella,
    fake: fake!,
    calls: run.calls,
    time,
  };
}

test("the exec seam wakes the agent's machine once and targets its container", async () => {
  const { stella, fake, calls } = machine();
  const exec = stella.exec("agent-a");
  await exec!(["true"], { timeoutMs: 1000 });
  await exec!(["true"], { timeoutMs: 1000 });
  assertEquals(fake.starts, ["agent-a"]);
  assertEquals(calls.length, 2);
  for (const call of calls) {
    assertEquals(call.includes(vmContainerName("agent-a")), true);
    // The display and the session bus are the container's own environment:
    // one container serves one agent, so no per-call override is needed.
    assertEquals(call.includes("DISPLAY=:99"), false);
  }
});

test("two agents get different machines", async () => {
  const { stella, fake, calls } = machine();
  await stella.exec("agent-a")!(["true"], { timeoutMs: 1000 });
  await stella.exec("agent-b")!(["true"], { timeoutMs: 1000 });
  assertEquals(fake.starts, ["agent-a", "agent-b"]);
  assertEquals(calls[1]!.includes(vmContainerName("agent-b")), true);
});

test("callers racing on a sleeping machine share one wake", async () => {
  const { stella, fake } = machine();
  const exec = stella.exec("agent-a")!;
  await Promise.all([
    exec(["true"], { timeoutMs: 1000 }),
    exec(["true"], { timeoutMs: 1000 }),
    stella.ensureReady("agent-a"),
  ]);
  assertEquals(fake.starts, ["agent-a"]);
});

test("an idle machine is stopped, and its next call wakes it again", async () => {
  const time = clock();
  const { stella, fake } = machine({ idleMs: 1_000, warmFloor: 0, time });
  const exec = stella.exec("agent-a")!;
  await exec(["true"], { timeoutMs: 1000 });
  time.advance(999);
  await stella.reapIdle();
  assertEquals(fake.stops, [], "the idle window has not passed");

  time.advance(1);
  await stella.reapIdle();
  assertEquals(fake.stops, ["agent-a"]);

  await exec(["true"], { timeoutMs: 1000 });
  assertEquals(fake.starts, ["agent-a", "agent-a"]);
});

test("four idle machines stay warm", async () => {
  const time = clock();
  const { stella, fake } = machine({ time });
  for (const agentId of ["a", "b", "c", "d"]) {
    await stella.ensureReady(agentId);
  }
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, []);
});

test("a fifth idle machine is paid for by the oldest one", async () => {
  const time = clock();
  const { stella, fake } = machine({ time });
  for (const agentId of ["a", "b", "c", "d", "e"]) {
    await stella.ensureReady(agentId);
    time.advance(100);
  }
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, ["a"]);
});

test("six idle machines settle to four one stop at a time", async () => {
  const time = clock();
  const { stella, fake } = machine({ time });
  for (const agentId of ["a", "b", "c", "d", "e", "f"]) {
    await stella.ensureReady(agentId);
    time.advance(100);
  }
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, ["a"]);
  await stella.reapIdle();
  assertEquals(fake.stops, ["a", "b"]);
  await stella.reapIdle();
  assertEquals(fake.stops, ["a", "b"]);
});

test("a busy oldest machine is skipped for the next oldest", async () => {
  const time = clock();
  const busy = new Set<string>(["a"]);
  const { stella, fake } = machine({
    busy: (agentId) => busy.has(agentId),
    time,
  });
  for (const agentId of ["a", "b", "c", "d", "e"]) {
    await stella.ensureReady(agentId);
    time.advance(100);
  }
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, ["b"]);
});

test("a watched machine is never stopped", async () => {
  const time = clock();
  const { stella, fake } = machine({ time, warmFloor: 0 });
  await stella.ensureReady("agent-a");
  stella.watch("agent-a");
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, []);

  // Closing the pane restarts the idle clock: the machine gets the usual
  // window, not an immediate stop.
  stella.unwatch("agent-a");
  time.advance(1_000);
  await stella.reapIdle();
  assertEquals(fake.stops, ["agent-a"]);
});

test("a sleeping machine closes its desktop before the container", async () => {
  const time = clock();
  const { stella, fake } = machine({ time, warmFloor: 0 });
  await stella.ensureReady("agent-a");
  time.advance(1_000);
  await stella.reapIdle();
  assertEquals(fake.desktopStops, 1);
  assertEquals(fake.stops, ["agent-a"]);
});

test("reconcile adopts machines a previous process left running", async () => {
  const time = clock();
  const { stella, fake } = machine({ time, warmFloor: 0 });
  fake.state.set("agent-a", RUNNING);

  await stella.reconcile(["agent-a", "agent-b"]);
  // A running machine is known without being started; a stopped one is
  // remembered as stopped without asking again.
  assertEquals(await stella.isRunning("agent-a"), true);
  assertEquals(await stella.isRunning("agent-b"), false);
  assertEquals(fake.starts, []);

  time.advance(1_000);
  await stella.reapIdle();
  assertEquals(fake.stops, ["agent-a"]);
});

test("stopAll closes the desktop before stopping the machines", async () => {
  const { stella, fake } = machine();
  await stella.ensureReady("agent-a");
  await stella.stopAll();
  assertEquals(fake.desktopStops, 1);
  assertEquals(fake.stops, ["agent-a"]);
});

test("a machine whose conversation is working is never stopped", async () => {
  const busy = new Set<string>(["agent-a"]);
  const time = clock();
  const { stella, fake } = machine({
    busy: (id) => busy.has(id),
    warmFloor: 0,
    time,
  });
  await stella.ensureReady("agent-a");
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, []);
});

test("a command in flight keeps the machine awake", async () => {
  const time = clock();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { stella, fake } = machine({
    time,
    warmFloor: 0,
    run: async (command) => {
      // Only the command under test waits; the folder the wake creates must
      // not hold the start.
      if (command.includes("hold")) await held;
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
      };
    },
  });
  // Woken first, so the wake's own touch happens before the clock moves: the
  // test is about a command that is still running, not about a wake that
  // lands after the idle window.
  await stella.ensureReady("agent-a");
  fake.starts.length = 0;
  const running = stella.exec("agent-a")!(["hold"], {
    timeoutMs: 60_000,
  });
  await Promise.resolve();
  time.advance(60_000);
  await stella.reapIdle();
  assertEquals(fake.stops, [], "a command is still running");
  release();
  await running;
  await stella.reapIdle();
  assertEquals(fake.stops, ["agent-a"]);
});

test("the idle clock is refreshed by use, not by the status poll", async () => {
  const time = clock();
  const { stella, fake } = machine({ time, warmFloor: 0 });
  await stella.ensureReady("agent-a");
  time.advance(700);
  await stella.machineStatus("agent-a");
  time.advance(700);
  // 1400ms since the wake, but the poll did not count as use; only the
  // wake's own touch does, so the machine stops here.
  await stella.reapIdle();
  assertEquals(fake.stops, ["agent-a"]);
});

test("a screen call wakes the machine and starts the desktop once", async () => {
  const { stella, fake } = machine();
  assertEquals(await stella.vncPortFor("agent-a"), 49152);
  await stella.screenExec("agent-a")!(["true"], { timeoutMs: 1000 });
  await stella.screenExec("agent-a")!(["true"], { timeoutMs: 1000 });
  assertEquals(fake.starts, ["agent-a"]);
  assertEquals(fake.desktops, ["agent-a"]);
});

test("a machine that slept starts its desktop again", async () => {
  const time = clock();
  const { stella, fake } = machine({ time, warmFloor: 0 });
  await stella.screenExec("agent-a")!(["true"], { timeoutMs: 1000 });
  time.advance(60_000);
  await stella.reapIdle();
  await stella.screenExec("agent-a")!(["true"], { timeoutMs: 1000 });
  assertEquals(fake.starts, ["agent-a", "agent-a"]);
  assertEquals(fake.desktops, ["agent-a", "agent-a"]);
});

test("opening a conversation does not wake a sleeping machine", async () => {
  const { stella, fake } = machine();
  // The first read states the machine as stopped; isRunning must not start
  // it, or browsing the sidebar would pay for a browser per row.
  assertEquals(await stella.isRunning("agent-a"), false);
  assertEquals(fake.starts, []);
});

test("release stops one machine and forgets it", async () => {
  const { stella, fake } = machine();
  await stella.ensureReady("agent-a");
  await stella.release("agent-a");
  assertEquals(fake.stops, ["agent-a"]);
  assertEquals(await stella.isRunning("agent-a"), false);
});

test("stopAll stops every machine the host knows", async () => {
  const { stella, fake } = machine();
  await stella.ensureReady("agent-a");
  await stella.ensureReady("agent-b");
  await stella.stopAll();
  assertEquals(new Set(fake.stops), new Set(["agent-a", "agent-b"]));
});

test("a removed machine is forgotten and does not answer again", async () => {
  const { stella, fake } = machine();
  await stella.ensureReady("agent-a");
  await stella.remove("agent-a");
  assertEquals(fake.stops, ["agent-a"]);
  assertEquals(await stella.isRunning("agent-a"), false);
});

/** The runners a skill-reading machine is built with: the exec seams record
 * their argv, and an `exec` that lists the agent's own skill folder answers
 * one skill (see vm/skills.ts). */
function skillAnswering(runner: ReturnType<typeof recorder>): MachineRunners {
  return {
    run: async (command) => {
      runner.calls.push([...command]);
      const dir = command[command.length - 1] ?? "";
      const stdout = dir.includes("/agents/")
        ? "\n__SKILL__mine\n---\nname: mine\ndescription: written by the agent\n---\nBody.\n"
        : "";
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
      };
    },
    runBytes: runner.runBytes,
  };
}

test("stopping every machine forgets the skill catalog of each agent", async () => {
  // The per-agent facts live in one record (see machine-state.ts). A stop
  // must leave nothing behind that described what the container was doing:
  // the desktop is gone and so is the catalog, which is why the next open
  // reads it again instead of answering from a stopped machine.
  const runner = recorder();
  const fake = fakeHost();
  const stella = new StellaMachine([], skillAnswering(runner), {
    warmFloor: VM_WARM_FLOOR,
    timer: false,
  });
  stella.set(fake.host);
  await stella.ensureReady("agent-a");
  await stella.ensureSkills("agent-a");
  assertEquals(stella.skills("agent-a").length > 0, true);

  await stella.stopAll();
  assertEquals(stella.skills("agent-a"), []);
});

test("removing a machine forgets its desktop and its catalog at once", async () => {
  const runner = recorder();
  const fake = fakeHost();
  const stella = new StellaMachine([], skillAnswering(runner), {
    warmFloor: VM_WARM_FLOOR,
    timer: false,
  });
  stella.set(fake.host);
  await stella.ensureReady("agent-a");
  await stella.screenExec("agent-a")!(["true"], { timeoutMs: 1000 });
  await stella.ensureSkills("agent-a");
  assertEquals(fake.desktops, ["agent-a"]);

  await stella.remove("agent-a");
  assertEquals(stella.skills("agent-a"), []);
  // The desktop record went too: a machine removed and rebuilt starts its
  // window manager rather than trusting a desktop that is gone.
  await stella.screenExec("agent-a")!(["true"], { timeoutMs: 1000 });
  assertEquals(fake.desktops, ["agent-a", "agent-a"]);
});
