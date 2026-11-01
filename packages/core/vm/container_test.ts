import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  containerFilesDigest,
  createVmManager,
  type VmProgress,
  type VmStatus,
} from "./container.ts";
import type { VmCommandResult, VmCommandRunner } from "./command.ts";
import {
  VM_CONTAINER_NAME,
  VM_DISPLAY,
  VM_IMAGE_DIGEST_LABEL,
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
 * (built, created, stopped, drifted contract, rebuilt image) without a podman
 * daemon, a multi-minute image build and a real X server on CI.
 */

interface Script {
  /** Exit code per command prefix (matched against the joined argv). A `once`
   * answer is consumed by its first match, which is how a test states a
   * command that succeeds only after the manager changed something. */
  answers: Array<{
    match: RegExp;
    result: Partial<VmCommandResult>;
    once?: boolean;
  }>;
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
    for (const answer of script.answers) {
      if (!answer.match.test(joined)) continue;
      if (answer.once === true) {
        const index = script.answers.indexOf(answer);
        script.answers.splice(index, 1);
      }
      return Promise.resolve({ ...ok(), ...answer.result });
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

/** The digest the directory above produces, i.e. what the image's label must
 * carry for the machine to count as current. */
async function currentDigest(dir: string): Promise<string> {
  const digest = await containerFilesDigest(dir);
  assert(digest !== null, "the container files must be readable");
  return digest;
}

/** The answers of a healthy, running machine whose image matches the files on
 * disk (`digest` is that directory's digest). */
function runningMachine(
  digest: string,
  overrides: Script["answers"] = [],
): Script {
  return {
    answers: [
      { match: /^podman --version/, result: ok("podman version 4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      {
        match: new RegExp(`^podman image inspect .*${VM_IMAGE_DIGEST_LABEL}`),
        result: ok(`${digest}\n`),
      },
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
      // The sudo probe the contract check runs.
      { match: /exec .* sudo -n true/, result: ok() },
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
  const digest = await currentDigest(dir);
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
          { match: /^podman image inspect/, result: ok(`${digest}\n`) },
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
          { match: /^podman image inspect/, result: ok(`${digest}\n`) },
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
  const digest = await currentDigest(dir);
  const { run } = makeRunner(runningMachine(digest));
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
  const digest = await currentDigest(dir);
  // A screen of the wrong size: every coordinate the agent reads off a
  // screenshot would be wrong, so the machine must not be offered.
  // The override stands first so it wins over the built-in geometry answer
  // (answers are matched in order).
  const { run } = makeRunner({
    answers: [{
      match: /xdotool getdisplaygeometry/,
      result: ok("1024 768\n"),
    }, ...runningMachine(digest).answers],
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

Deno.test("status: a machine without passwordless sudo is refused", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run } = makeRunner({
    answers: [{
      match: /exec .* sudo -n true/,
      result: fail("sudo: a password is required"),
    }, ...runningMachine(digest).answers],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status();
    // Not offered: a shell that stops at a password prompt has no answer
    // inside this conversation, so the machine must not pretend to work.
    assertEquals(status.state, "stopped");
    assert(
      status.reason.includes("cannot run sudo without a password"),
      `reason must name sudo: ${status.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: an image built from older container files is stale", async () => {
  const dir = await containerDir();
  const { run } = makeRunner(runningMachine("a-digest-from-some-other-build"));
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status();
    assertEquals(status.state, "image_stale");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: an image without a digest label counts as stale", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  // An image built before the label existed answers with nothing for it.
  const { run } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman image inspect/, result: ok("\n") },
    ],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    assertEquals((await manager.status()).state, "image_stale");
    // Sanity: with the label present the same script is a current image.
    const { run: labelled } = makeRunner(runningMachine(digest));
    const status = await createVmManager({ containerDir: dir, run: labelled })
      .status();
    assertEquals(status.state, "running");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container files digest: every file in the directory counts", async () => {
  const dir = await containerDir();
  try {
    const before = await containerFilesDigest(dir);
    assert(before !== null, "the digest must be computable");
    // A second file (entry.sh is COPYed by the Containerfile) changes it.
    await Deno.writeTextFile(join(dir, "entry.sh"), "#!/bin/sh\n");
    const afterFile = await containerFilesDigest(dir);
    assert(afterFile !== before, "adding a file must change the digest");
    // So does an edit to the instruction itself.
    await Deno.writeTextFile(
      join(dir, "Containerfile"),
      "FROM scratch\nRUN true\n",
    );
    const afterEdit = await containerFilesDigest(dir);
    assert(afterEdit !== afterFile, "an edit must change the digest");
    // A directory that does not exist has no definition to hash.
    assertEquals(await containerFilesDigest(join(dir, "missing")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: the answer is cached, and fresh bypasses the cache", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner(runningMachine(digest));
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

Deno.test("start: a missing image is built, created, started and verified", async () => {
  const dir = await containerDir();
  const progress: VmProgress[] = [];
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      // First the image is missing; after the build it exists.
      { match: /^podman image exists/, result: fail("", 1) },
      { match: /^podman build/, result: ok("built\n") },
      { match: /^podman create /, result: ok("abc123\n") },
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
      { match: /exec .* sudo -n true/, result: ok() },
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
    // The build records which container files it was made from, so the next
    // start can tell an edited Containerfile from a current one.
    const build = joined.find((c) => c.startsWith("podman build")) ?? "";
    assert(
      build.includes(
        `--label ${VM_IMAGE_DIGEST_LABEL}=${await currentDigest(dir)}`,
      ),
      `the build must record the definition's digest: ${build}`,
    );
    assert(
      joined.some((c) => c.startsWith("podman create ")),
      `no container creation: ${joined.join("\n")}`,
    );
    assertEquals(
      progress.map((p) => p.phase),
      [
        "building_image",
        "creating_container",
        "starting_container",
        "verifying",
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start: a running machine is left alone", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner(runningMachine(digest));
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

Deno.test("start: a broken container is recreated, keeping the agent's home", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman image inspect/, result: ok(`${digest}\n`) },
      { match: /^podman container inspect/, result: ok("running true\n") },
      { match: /^podman port/, result: ok("127.0.0.1:49153\n") },
      // A drifted display: the machine is reported as stopped+reason.
      { match: /printf .*DISPLAY/, result: ok(`:0|${VM_UID}|${VM_WORKDIR}\n`) },
      { match: /^podman rm/, result: ok() },
      { match: /^podman create /, result: ok("abc123\n") },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
      { match: /exec .* sudo -n true/, result: ok() },
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
    // The home is the agent's work: it is saved before the container is
    // dropped and put back before the new one starts.
    const copyOut = joined.findIndex((c) =>
      c.startsWith(`podman cp ${VM_CONTAINER_NAME}:${VM_WORKDIR}`)
    );
    const removed = joined.findIndex((c) => c.startsWith("podman rm"));
    const created = joined.findIndex((c) => c.startsWith("podman create "));
    const copyIn = joined.findIndex((c) =>
      c.startsWith("podman cp ") &&
      c.endsWith(`${VM_CONTAINER_NAME}:${VM_WORKDIR}/`)
    );
    assert(copyOut !== -1, `the home must be saved: ${joined.join("\n")}`);
    assert(removed > copyOut, "the home must be saved before the removal");
    assert(created > removed, "a fresh container must follow the removal");
    assert(
      copyIn > created,
      "the home must be restored into the new container",
    );
    assert(
      joined.some((c) => c.startsWith("podman start")),
      `the new container must be started: ${joined.join("\n")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start: a stale image is rebuilt from the container files", async () => {
  const dir = await containerDir();
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      // An older build: the label names a different set of files.
      { match: /^podman image inspect/, result: ok("older-digest\n") },
      { match: /^podman container exists/, result: ok() },
      { match: /^podman container inspect/, result: ok("running true\n") },
      { match: /^podman port/, result: ok("127.0.0.1:49153\n") },
      { match: /^podman build/, result: ok("built\n") },
      { match: /^podman create /, result: ok("abc123\n") },
      {
        match: /printf .*DISPLAY/,
        result: ok(`${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n`),
      },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
      { match: /exec .* sudo -n true/, result: ok() },
    ],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    // The script keeps answering with the old label, so the machine never
    // becomes current: the start must fail rather than claim success.
    await assertRejects(() => manager.start(), Error);
    const joined = calls.map((c) => c.join(" "));
    assert(
      joined.some((c) => c.startsWith("podman build")),
      `the image must be rebuilt: ${joined.join("\n")}`,
    );
    const saved = joined.findIndex((c) =>
      c.startsWith(`podman cp ${VM_CONTAINER_NAME}:${VM_WORKDIR}`)
    );
    const build = joined.findIndex((c) => c.startsWith("podman build"));
    assert(saved !== -1, `the home must be saved: ${joined.join("\n")}`);
    assert(saved < build, "the home must be saved before the image is rebuilt");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("start: an image with no container yet needs no home to carry", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman image inspect/, result: ok(`${digest}\n`) },
      // No container at first; the one created below answers.
      {
        match: /^podman container inspect/,
        result: fail("no such"),
        once: true,
      },
      { match: /^podman container inspect/, result: ok("running true\n") },
      { match: /^podman create /, result: ok("abc123\n") },
      { match: /^podman port/, result: ok("127.0.0.1:49153\n") },
      {
        match: /printf .*DISPLAY/,
        result: ok(`${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n`),
      },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
      { match: /exec .* sudo -n true/, result: ok() },
    ],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    await manager.start();
    const joined = calls.map((c) => c.join(" "));
    assertEquals(
      joined.some((c) => c.startsWith("podman cp")),
      false,
      `there is no home to carry: ${joined.join("\n")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stop: a stopped or absent machine is not an error", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
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
          ...runningMachine(digest).answers,
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
  const digest = await currentDigest(dir);
  const { run } = makeRunner({
    answers: [{
      match: /^podman port/,
      result: fail("no port mapping"),
    }, ...runningMachine(digest).answers],
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

Deno.test("status: a second fresh read does not ask about the image again", async () => {
  // The status endpoint polls, and every `podman` call is a round trip the
  // user waits on when the server is reached over a phone. Once an image has
  // been seen, `image exists` is not asked again; the container inspect still
  // runs, so a machine that disappeared is still reported.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  try {
    const script = runningMachine(digest);
    const { run, calls } = makeRunner(script);
    const manager = createVmManager({ containerDir: dir, run });
    assertEquals((await manager.status({ fresh: true })).state, "running");
    const afterFirst = calls.filter((call) =>
      call.join(" ").startsWith("podman image exists")
    ).length;
    assertEquals(afterFirst, 1);
    assertEquals((await manager.status({ fresh: true })).state, "running");
    const afterSecond = calls.filter((call) =>
      call.join(" ").startsWith("podman image exists")
    ).length;
    assertEquals(afterSecond, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: concurrent reads share one round of podman calls", async () => {
  // The status poll, an open and the screen's port lookup can overlap. Each
  // used to run its own podman calls; now they wait for the same read.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  try {
    const { run, calls } = makeRunner(runningMachine(digest));
    const manager = createVmManager({ containerDir: dir, run });
    const [a, b] = await Promise.all([
      manager.status({ fresh: true }),
      manager.status({ fresh: true }),
    ]);
    assertEquals(a.state, "running");
    assertEquals(b.state, "running");
    const versionCalls = calls.filter((call) =>
      call.join(" ") === "podman --version"
    ).length;
    assertEquals(versionCalls, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
