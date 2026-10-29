import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  createVmManager,
  type VmProgress,
  type VmStatus,
} from "./container.ts";
import type { VmCommandResult, VmCommandRunner } from "./command.ts";
import {
  VM_CONTAINER_NAME,
  VM_DISPLAY,
  VM_SCREEN_HEIGHT,
  VM_SCREEN_WIDTH,
  VM_UID,
  VM_VNC_PORT,
  VM_WORKDIR,
} from "./contract.ts";

/**
 * The container manager is exercised against a scripted podman: every test
 * states what the machine answers and asserts what the manager decided and
 * which commands it ran. That is the only way to test the states that matter
 * (built, created, stopped, drifted contract) without a podman daemon, a
 * multi-minute image build and a real X server on CI.
 */

interface Script {
  /** Exit code per command prefix (matched against the joined argv). */
  answers: Array<{ match: RegExp; result: Partial<VmCommandResult> }>;
  /** Fallback for anything unmatched: a command that "succeeded" silently. */
  fallback?: Partial<VmCommandResult>;
}

function ok(stdout = "", extra: Partial<VmCommandResult> = {}) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    truncated: false,
    timedOut: false,
    ...extra,
  };
}

function fail(stderr: string, exitCode = 1): Partial<VmCommandResult> {
  return { exitCode, stdout: "", stderr, truncated: false, timedOut: false };
}

function makeRunner(script: Script): {
  run: VmCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: VmCommandRunner = (command) => {
    const argv = [...command];
    calls.push(argv);
    const joined = argv.join(" ");
    for (const { match, result } of script.answers) {
      if (match.test(joined)) {
        return Promise.resolve({ ...ok(), ...result });
      }
    }
    return Promise.resolve({ ...ok(), ...script.fallback });
  };
  return { run, calls };
}

/** A directory holding the Containerfile the build step requires (the
 * manager takes the directory that CONTAINS the container files, wherever the
 * server resolved it). */
async function containerDir(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "lumisca-vm-" });
  await Deno.writeTextFile(join(root, "Containerfile"), "FROM scratch\n");
  return root;
}

/** The answers of a healthy, running machine. */
function runningMachine(overrides: Script["answers"] = []): Script {
  return {
    answers: [
      { match: /^podman --version/, result: ok("podman version 4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      {
        match: /^podman container inspect/,
        result: ok("running true\n"),
      },
      { match: /^podman port/, result: ok(`127.0.0.1:49153\n`) },
      {
        // The env probe the contract check runs (display|uid|workdir).
        match: /printf .*DISPLAY/,
        result: ok(`${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n`),
      },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
      ...overrides,
    ],
  };
}

Deno.test("status: podman missing is reported with its reason", async () => {
  const dir = await containerDir();
  const { run } = makeRunner({
    answers: [{
      match: /^podman --version/,
      result: fail("podman: command not found"),
    }],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status();
    assertEquals(status.state, "podman_missing");
    assertEquals(status.vncPort, null);
    assert(
      status.reason.includes("podman is not available"),
      `reason: ${status.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: image_missing / container_missing / stopped", async () => {
  const dir = await containerDir();
  try {
    {
      const { run } = makeRunner({
        answers: [
          { match: /^podman --version/, result: ok("4.9.3\n") },
          { match: /^podman image exists/, result: fail("", 1) },
        ],
      });
      const manager = createVmManager({ containerDir: dir, run });
      assertEquals((await manager.status()).state, "image_missing");
    }
    {
      const { run } = makeRunner({
        answers: [
          { match: /^podman --version/, result: ok("4.9.3\n") },
          { match: /^podman image exists/, result: ok() },
          { match: /^podman container inspect/, result: fail("no such") },
        ],
      });
      const manager = createVmManager({ containerDir: dir, run });
      assertEquals((await manager.status()).state, "container_missing");
    }
    {
      const { run } = makeRunner({
        answers: [
          { match: /^podman --version/, result: ok("4.9.3\n") },
          { match: /^podman image exists/, result: ok() },
          { match: /^podman container inspect/, result: ok("exited false\n") },
        ],
      });
      const manager = createVmManager({ containerDir: dir, run });
      const status = await manager.status();
      assertEquals(status.state, "stopped");
      assertEquals(status.reason, "");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: a running machine reports its VNC port", async () => {
  const dir = await containerDir();
  const { run } = makeRunner(runningMachine());
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status();
    assertEquals(status.state, "running");
    assertEquals(status.vncPort, 49153);
    assertEquals(status.reason, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: a drifted contract is reported as stopped with the reason", async () => {
  const dir = await containerDir();
  // A screen of the wrong size: every coordinate the agent reads off a
  // screenshot would be wrong, so the machine must not be offered.
  // The override stands first so it wins over the built-in geometry answer
  // (answers are matched in order).
  const { run } = makeRunner({
    answers: [{
      match: /xdotool getdisplaygeometry/,
      result: ok("1024 768\n"),
    }, ...runningMachine().answers],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status();
    assertEquals(status.state, "stopped");
    assert(
      status.reason.includes("1024x768"),
      `reason must name the mismatch: ${status.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: the answer is cached, and fresh bypasses the cache", async () => {
  const dir = await containerDir();
  const { run, calls } = makeRunner(runningMachine());
  try {
    const manager = createVmManager({ containerDir: dir, run });
    await manager.status();
    const afterFirst = calls.length;
    await manager.status();
    assertEquals(calls.length, afterFirst, "the second call must be cached");
    await manager.status({ fresh: true });
    assert(calls.length > afterFirst, "fresh must ask podman again");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start: a missing image is built, created and verified", async () => {
  const dir = await containerDir();
  const progress: VmProgress[] = [];
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      // First the image is missing; after the build it exists.
      { match: /^podman image exists/, result: fail("", 1) },
      { match: /^podman build/, result: ok("built\n") },
      { match: /^podman run /, result: ok("abc123\n") },
      { match: /^podman container inspect/, result: ok("running true\n") },
      { match: /^podman port/, result: ok("127.0.0.1:49153\n") },
      {
        match: /printf .*DISPLAY/,
        result: ok(`${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n`),
      },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
    ],
  });
  try {
    const manager = createVmManager({
      containerDir: dir,
      run,
      onProgress: (p) => progress.push(p),
    });
    // This script keeps answering "image exists: no", so the verification
    // after the build cannot find a running machine: the start must fail
    // loudly rather than report a machine that is not there.
    await assertRejects(() => manager.start(), Error);
    // The build, the container creation and the verification ran in order.
    const joined = calls.map((c) => c.join(" "));
    assert(
      joined.some((c) => c.startsWith("podman build")),
      `no build: ${joined.join("\n")}`,
    );
    assert(
      joined.some((c) => c.startsWith("podman run ")),
      `no container creation: ${joined.join("\n")}`,
    );
    assertEquals(
      progress.map((p) => p.phase),
      ["building_image", "creating_container", "verifying"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start: a running machine is left alone", async () => {
  const dir = await containerDir();
  const { run, calls } = makeRunner(runningMachine());
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.start();
    assertEquals(status.state, "running");
    const joined = calls.map((c) => c.join(" "));
    assertEquals(
      joined.some((c) =>
        c.includes("podman start") || c.includes("podman build")
      ),
      false,
      `nothing must be started: ${joined.join("\n")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start: a missing image definition fails with its path", async () => {
  const root = await Deno.makeTempDir({ prefix: "lumisca-vm-" });
  try {
    const { run } = makeRunner({
      answers: [
        { match: /^podman --version/, result: ok("4.9.3\n") },
        { match: /^podman image exists/, result: fail("", 1) },
      ],
    });
    const manager = createVmManager({ containerDir: root, run });
    await assertRejects(
      () => manager.start(),
      Error,
      "image definition is missing",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("start: a broken container is recreated rather than reused", async () => {
  const dir = await containerDir();
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman container inspect/, result: ok("running true\n") },
      { match: /^podman port/, result: ok("127.0.0.1:49153\n") },
      // A drifted display: the machine is reported as stopped+reason.
      { match: /printf .*DISPLAY/, result: ok(`:0|${VM_UID}|${VM_WORKDIR}\n`) },
      { match: /^podman rm/, result: ok() },
      { match: /^podman run /, result: ok("abc123\n") },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
    ],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    await assertRejects(() => manager.start(), Error);
    const joined = calls.map((c) => c.join(" "));
    assertEquals(
      joined.some((c) => c.startsWith("podman rm")),
      true,
      `the broken container must be removed: ${joined.join("\n")}`,
    );
    assertEquals(
      joined.some((c) => c.startsWith("podman run ")),
      true,
      `a fresh container must be created: ${joined.join("\n")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop: a stopped or absent machine is not an error", async () => {
  const dir = await containerDir();
  try {
    {
      const { run, calls } = makeRunner({
        answers: [
          { match: /^podman --version/, result: ok("4.9.3\n") },
          { match: /^podman image exists/, result: fail("", 1) },
        ],
      });
      const manager = createVmManager({ containerDir: dir, run });
      await manager.stop();
      assertEquals(
        calls.some((c) => c.join(" ").startsWith("podman stop")),
        false,
      );
    }
    {
      const { run, calls } = makeRunner({
        answers: [
          { match: /^podman stop/, result: ok(`${VM_CONTAINER_NAME}\n`) },
          ...runningMachine().answers,
        ],
      });
      const manager = createVmManager({ containerDir: dir, run });
      await manager.stop();
      assertEquals(
        calls.some((c) => c.join(" ").startsWith("podman stop")),
        true,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: the VNC port is null when the machine is not running", async () => {
  const dir = await containerDir();
  const { run } = makeRunner({
    answers: [{
      match: /^podman port/,
      result: fail("no port mapping"),
    }, ...runningMachine().answers],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status: VmStatus = await manager.status();
    assertEquals(status.vncPort, null);
    assertEquals(await manager.vncPort(), null);
    // The port constant is part of the contract; the mapping is not.
    assertEquals(VM_VNC_PORT, 6080);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
