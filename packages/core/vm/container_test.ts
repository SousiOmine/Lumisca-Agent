import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  containerFilesDigest,
  createVmManager,
  type VmProgress,
  type VmStatus,
} from "./container.ts";
import type { VmCommandResult, VmCommandRunner } from "./command.ts";
import { stellaAvailability } from "./availability.ts";
import {
  VM_A11Y_HELPER,
  VM_CONTAINER_NAME,
  VM_DBUS_ADDRESS,
  VM_DISPLAY,
  VM_HOME_VOLUME,
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

/** The answer of one healthy contract probe: the single `podman exec` that
 * prints the display, the uid, the workdir, the screen size, whether sudo
 * works, and whether the semantic tools' bus, accessibility setting and helper
 * are in place. A probe that cannot run leaves its own line out, so tests
 * change one line to state one drift. */
const CONTRACT_OK = `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
  `geometry=${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n` +
  `sudo=ok\n` +
  `dbus=${VM_DBUS_ADDRESS}\n` +
  `toolkit=true\n` +
  `helper={"error":"no running application matches 'definitely-not-running'"}\n`;

/** The three lines the accessibility probes print when everything is in
 * place. A test that states one drift keeps them and changes that one line. */
const A11Y_LINES = `dbus=${VM_DBUS_ADDRESS}\ntoolkit=true\n` +
  `helper={"error":"no running application matches 'x'"}\n`;

/** The answer of one `podman container inspect`: the instance, its state and
 * the screen's published port, as the manager's template asks for them. */
function containerFacts(
  options: {
    id?: string;
    status?: string;
    startedAt?: string;
    port?: number | null;
  } = {},
): string {
  const ports = options.port == null ? {} : {
    [`${VM_VNC_PORT}/tcp`]: [{
      HostIp: "127.0.0.1",
      HostPort: String(options.port),
    }],
  };
  return `${options.id ?? "c0ffee"}\t${options.status ?? "running"}\t` +
    `${options.startedAt ?? "2026-01-01T00:00:00Z"}\t${
      JSON.stringify(ports)
    }\n`;
}

/** The answers of a healthy, running machine whose image matches the files on
 * disk (`digest` is that directory's digest). */
function runningMachine(
  digest: string,
  overrides: Script["answers"] = [],
): Script {
  // Overrides go FIRST: the fake runner takes the first match, so a test that
  // changes one answer must be asked before the healthy default.
  return {
    answers: [
      ...overrides,
      { match: /^podman --version/, result: ok("podman version 4.9.3\n") },
      // The run probe: a host able to run a container answers this one.
      { match: /^podman run --rm --network=none/, result: ok() },
      { match: /^podman image exists/, result: ok() },
      {
        match: new RegExp(`^podman image inspect .*${VM_IMAGE_DIGEST_LABEL}`),
        result: ok(`${digest}\n`),
      },
      {
        match: /^podman container inspect/,
        result: ok(containerFacts({ port: 49153 })),
      },
      // The one exec the contract check runs: the display, the uid, the
      // workdir, the screen size and the sudo answer, as `name=value` lines.
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
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
          {
            match: /^podman container inspect/,
            result: ok(containerFacts({ status: "exited", port: null })),
          },
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
  // The override stands first so it wins over the built-in contract answer
  // (answers are matched in order).
  const { run } = makeRunner({
    answers: [{
      match: /printf .*DISPLAY/,
      result: ok(
        `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
          `geometry=1024 768\nsudo=ok\n` +
          A11Y_LINES,
      ),
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
      match: /printf .*DISPLAY/,
      result: ok(
        `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
          `geometry=${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n` +
          `sudo_error=sudo: a password is required\n` +
          A11Y_LINES,
      ),
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

Deno.test("status: a machine whose screen is not up is refused", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  // The ordinary failure of a container that has not finished booting: the
  // other values are right and only the screen is missing. It must read as
  // "the screen is not up", not as a wrong display.
  const { run } = makeRunner({
    answers: [{
      match: /printf .*DISPLAY/,
      result: ok(
        `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
          `geometry_error=Can't open display: :99\nsudo=ok\n` +
          A11Y_LINES,
      ),
    }, ...runningMachine(digest).answers],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status();
    assertEquals(status.state, "stopped");
    assert(
      status.reason.includes("screen is not up"),
      `reason must name the screen: ${status.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: a machine without the accessibility bus is refused", async () => {
  // The semantic tools (vm_find / vm_do / vm_wait) reach the machine's widgets
  // through one bus at a fixed address. A machine whose bus is somewhere else
  // answers every find with "no running application", which reads like a
  // missing window rather than a broken machine — so it is refused at start-up.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run } = makeRunner({
    answers: [{
      match: /printf .*DISPLAY/,
      result: ok(
        `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
          `geometry=${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n` +
          `sudo=ok\n` +
          `dbus=unix:path=/run/user/1000/bus\ntoolkit=true\n` +
          `helper={"error":"no running application matches 'x'"}\n`,
      ),
    }, ...runningMachine(digest).answers],
  });
  try {
    const status = await createVmManager({ containerDir: dir, run }).status();
    assertEquals(status.state, "stopped");
    assert(
      status.reason.includes("/run/user/1000/bus"),
      `reason must name the bus: ${status.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: a machine with accessibility off is refused", async () => {
  // An application started while `toolkit-accessibility` was false never
  // appears on the bus, whatever is set afterwards: the whole GUI is invisible
  // to the semantic tools and only the pixel path works. Say so at start-up.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run } = makeRunner({
    answers: [{
      match: /printf .*DISPLAY/,
      result: ok(
        `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
          `geometry=${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n` +
          `sudo=ok\ndbus=${VM_DBUS_ADDRESS}\ntoolkit=false\n` +
          `helper={"error":"no running application matches 'x'"}\n`,
      ),
    }, ...runningMachine(digest).answers],
  });
  try {
    const status = await createVmManager({ containerDir: dir, run }).status();
    assertEquals(status.state, "stopped");
    assert(
      status.reason.includes("toolkit-accessibility"),
      `reason must name the setting: ${status.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: a machine whose accessibility helper is missing is refused", async () => {
  // A helper that cannot run turns every semantic call into an unexplained
  // "the machine did not answer". The probe runs it once with a request that
  // cannot find anything, so success only proves the program runs.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run } = makeRunner({
    answers: [{
      match: /printf .*DISPLAY/,
      result: ok(
        `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
          `geometry=${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n` +
          `sudo=ok\ndbus=${VM_DBUS_ADDRESS}\ntoolkit=true\n` +
          `helper_error=python3: can't open file '/usr/local/lib/lumisca/a11y.py': ` +
          `[Errno 2] No such file or directory\n`,
      ),
    }, ...runningMachine(digest).answers],
  });
  try {
    const status = await createVmManager({ containerDir: dir, run }).status();
    assertEquals(status.state, "stopped");
    assert(
      status.reason.includes("accessibility helper did not run"),
      `reason must name the helper: ${status.reason}`,
    );
    assert(status.reason.includes("a11y.py"), status.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: the accessibility helper is probed with a request that finds nothing", async () => {
  // The probe must not depend on any window existing, and it must not report
  // a healthy bus as broken because a find legitimately matched nothing.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner(runningMachine(digest));
  try {
    assertEquals(
      (await createVmManager({ containerDir: dir, run }).status())
        .state,
      "running",
    );
    const probe = calls.find((call) => call.join(" ").includes("printf"));
    assert(probe !== undefined);
    const joined = probe.join(" ");
    assert(joined.includes(VM_A11Y_HELPER), joined);
    assert(joined.includes("definitely-not-running"), joined);
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

Deno.test("container files digest: a nested file still counts", async () => {
  // The container directory ships as a tree and the digest walks it: a
  // digest that only hashed the top level would keep an image whose files
  // are out of date for the life of the installation.
  const dir = await containerDir();
  try {
    const before = await containerFilesDigest(dir);
    await Deno.mkdir(join(dir, "nested"));
    await Deno.writeTextFile(join(dir, "nested", "extra.txt"), "one\n");
    const after = await containerFilesDigest(dir);
    assert(after !== before, "adding a nested file must change the digest");

    // An edit inside it must too, not only its presence.
    await Deno.writeTextFile(join(dir, "nested", "extra.txt"), "two\n");
    const edited = await containerFilesDigest(dir);
    assert(edited !== after, "editing a nested file must change the digest");
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
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      // The one exec the contract check runs.
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
      // `waitForScreen` waits for the entry point with one xdotool call.
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

Deno.test("start: a broken container is recreated on the same home volume", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman image inspect/, result: ok(`${digest}\n`) },
      // The container this version created already mounts the home volume,
      // so nothing has to be migrated.
      {
        match: /^podman container inspect --format \{\{range \.Mounts\}\}/,
        result: ok(`${VM_WORKDIR}=volume\n`),
      },
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      // A drifted display: the machine is reported as stopped+reason.
      {
        match: /printf .*DISPLAY/,
        result: ok(
          `env=:0|${VM_UID}|${VM_WORKDIR}\n` +
            `geometry=${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\nsudo=ok\n`,
        ),
      },
      { match: /^podman rm/, result: ok() },
      { match: /^podman create /, result: ok("abc123\n") },
      // `waitForScreen` waits for the entry point with one xdotool call.
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
    // The home is the agent's work, and it is NOT carried through a copy any
    // more: it lives on a named volume that podman keeps when the container
    // is removed. What this pins is that every container created for the
    // machine mounts that volume, and that nothing copies the home (a copy
    // cannot work when there is no container to copy from).
    const removed = joined.findIndex((c) => c.startsWith("podman rm"));
    const created = joined.findIndex((c) => c.startsWith("podman create "));
    assert(created > removed, "a fresh container must follow the removal");
    assert(
      joined.some((c) =>
        c.includes(`--volume ${VM_HOME_VOLUME}:${VM_WORKDIR}`)
      ),
      `the new container must mount the home volume: ${joined.join("\n")}`,
    );
    assertEquals(
      joined.filter((c) => c.startsWith("podman cp")).length,
      0,
      `the home must not be copied: ${joined.join("\n")}`,
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
      // The container this version created already mounts the home volume,
      // so nothing has to be migrated.
      {
        match: /^podman container inspect --format \{\{range \.Mounts\}\}/,
        result: ok(`${VM_WORKDIR}=volume\n`),
      },
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      { match: /^podman build/, result: ok("built\n") },
      { match: /^podman create /, result: ok("abc123\n") },
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
      // `waitForScreen` waits for the entry point with one xdotool call.
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
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
    // Nothing is copied: the home is on a volume that survives both the
    // rebuild and the removed container.
    assertEquals(
      joined.filter((c) => c.startsWith("podman cp")).length,
      0,
      `the home must not be copied: ${joined.join("\n")}`,
    );
    assert(
      joined.some((c) =>
        c.includes(`--volume ${VM_HOME_VOLUME}:${VM_WORKDIR}`)
      ),
      `the rebuilt machine must mount the home volume: ${joined.join("\n")}`,
    );
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
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      { match: /^podman create /, result: ok("abc123\n") },
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
      // `waitForScreen` waits for the entry point with one xdotool call.
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
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

Deno.test("status: the VNC port is null when the machine publishes none", async () => {
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run } = makeRunner({
    answers: [{
      match: /^podman container inspect/,
      result: ok(containerFacts({ port: null })),
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

Deno.test("status: the contract is proven once per container instance", async () => {
  // The client polls the status while it watches stella mode. Re-proving the
  // contract on every read made each poll four `podman exec` spawns; the
  // answer cannot change while the same instance runs, so it is asked once.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  try {
    const { run, calls } = makeRunner(runningMachine(digest));
    const manager = createVmManager({ containerDir: dir, run });
    assertEquals((await manager.status({ fresh: true })).state, "running");
    const probes = () =>
      calls.filter((call) => call.join(" ").includes("printf")).length;
    assertEquals(probes(), 1);
    assertEquals((await manager.status({ fresh: true })).state, "running");
    assertEquals(probes(), 1, "the same instance must not be asked again");

    // A new instance (the container was restarted or recreated) is verified
    // again: it is the one thing that can have drifted since.
    const restarted = makeRunner(
      runningMachine(digest, [{
        match: /^podman container inspect/,
        result: ok(containerFacts({ port: 49153, startedAt: "later" })),
      }]),
    );
    assertEquals(
      (await createVmManager({ containerDir: dir, run: restarted.run })
        .status())
        .state,
      "running",
    );
    const secondProbes = restarted.calls.filter((call) =>
      call.join(" ").includes("printf")
    ).length;
    assertEquals(secondProbes, 1, "a fresh manager asks once");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("status: a machine that is still booting is not remembered as broken", async () => {
  // The ordinary mismatch is a container that has not finished bringing its
  // screen up. Remembering that would report a working machine as broken for
  // as long as the container lived.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  try {
    const { run } = makeRunner({
      answers: [
        {
          match: /printf .*DISPLAY/,
          result: ok(
            `env=${VM_DISPLAY}|${VM_UID}|${VM_WORKDIR}\n` +
              `geometry_error=Can't open display: :99\nsudo=ok\n`,
          ),
          once: true,
        },
        ...runningMachine(digest).answers,
      ],
    });
    const manager = createVmManager({ containerDir: dir, run });
    const first = await manager.status({ fresh: true });
    assertEquals(first.state, "stopped");
    const second = await manager.status({ fresh: true });
    assertEquals(second.state, "running");
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
  // The status poll, an open and the screen's port lookup can overlap. One
  // read has to serve all of them: a podman spawn per caller multiplies the
  // cost of a page that only wants to know whether the machine is up.
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

Deno.test("status: podman that cannot start a container is not offered", async () => {
  // Regression: `podman --version` succeeding was taken as "stella mode
  // works here". Inside a sandboxed container podman answers and every start
  // fails at the runtime — the mode was offered, an image build ran for
  // minutes, and the failure named a kernel path. The host's answer is
  // asked before the mode is offered.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  try {
    const { run } = makeRunner(runningMachine(digest, [{
      match: /^podman run --rm --network=none/,
      result: fail(
        "Error: OCI runtime error: crun: open " +
          "/proc/sys/net/ipv4/ping_group_range: Read-only file system",
      ),
    }]));
    const manager = createVmManager({ containerDir: dir, run });
    const status = await manager.status({ fresh: true });
    assertEquals(status.state, "podman_unusable");
    assert(
      status.reason.includes("ping_group_range"),
      `reason: ${status.reason}`,
    );
    // Not a reason to hide the mode behind a build: the machine is refused,
    // and the sentence says why without naming a kernel file.
    const verdict = stellaAvailability(status);
    assertEquals(verdict.available, false);
    assert(verdict.available === false, "the mode must be refused");
    assert(
      verdict.reason.includes("cannot start one"),
      `verdict: ${verdict.reason}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the home volume is mounted on every container the machine makes", async () => {
  // The reason the volume exists: a container is replaced (a release rebuilds
  // it) and can be removed by anything, and the files the agent wrote must
  // not go with it. A container created WITHOUT the mount would start on an
  // empty home and look healthy — the worst kind of failure.
  const dir = await containerDir();
  const digest = await currentDigest(dir);
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman image inspect/, result: ok(`${digest}\n`) },
      // No container yet: the machine is created from scratch.
      {
        match: /^podman container inspect/,
        result: fail("no such"),
        once: true,
      },
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      { match: /^podman create /, result: ok("abc123\n") },
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
      {
        match: /xdotool getdisplaygeometry/,
        result: ok(`${VM_SCREEN_WIDTH} ${VM_SCREEN_HEIGHT}\n`),
      },
    ],
  });
  try {
    const manager = createVmManager({ containerDir: dir, run });
    await manager.start();
    const create = calls
      .map((c) => c.join(" "))
      .find((c) => c.startsWith("podman create "));
    assert(create !== undefined, "the machine must be created");
    assert(
      create!.includes(`--volume ${VM_HOME_VOLUME}:${VM_WORKDIR}`),
      `the home must be on its volume: ${create}`,
    );
    // A named volume, not a host path: the machine's isolation rests on
    // nothing of the host being reachable from inside.
    assert(
      !create!.includes("/home/agent/agents") &&
        !create!.includes(VM_WORKDIR + ":"),
      `nothing of the host may be mounted: ${create}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an install older than the volume has its home moved onto it", async () => {
  // The container from before the volume keeps its home in its own writable
  // layer. Replacing it without moving the files would start the machine on
  // an empty volume and delete the old container — the files would be gone
  // with no error to show for it.
  const dir = await containerDir();
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      // An older build: the container files changed under the image.
      { match: /^podman image inspect/, result: ok("older-digest\n") },
      { match: /^podman container exists/, result: ok() },
      // The old container's home is in its own layer, not on a volume.
      {
        match: /^podman container inspect --format \{\{range .Mounts\}\}/,
        result: ok(`${VM_WORKDIR}=bind\n`),
      },
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      { match: /^podman stop/, result: ok() },
      { match: /^podman cp /, result: ok() },
      { match: /^podman rm/, result: ok() },
      { match: /^podman build/, result: ok("built\n") },
      { match: /^podman create /, result: ok("abc123\n") },
      { match: /^podman start/, result: ok() },
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
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
    // The files are read out of the OLD container before it is removed...
    const copyOut = joined.findIndex((c) =>
      c.startsWith(`podman cp ${VM_CONTAINER_NAME}:${VM_WORKDIR}`)
    );
    const removed = joined.findIndex((c) => c.startsWith("podman rm"));
    const created = joined.findIndex((c) => c.startsWith("podman create "));
    const copyIn = joined.findIndex((c) =>
      c.startsWith("podman cp ") &&
      c.endsWith(`${VM_CONTAINER_NAME}:${VM_WORKDIR}/`)
    );
    assert(copyOut !== -1, `the home must be read out: ${joined.join("\n")}`);
    assert(
      removed > copyOut,
      "the old container must keep the files until read",
    );
    assert(created > removed, "the replacement comes after the removal");
    assert(copyIn > created, "the files go into the volume-backed container");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a container already on the volume is not migrated again", async () => {
  // Every start after the first would otherwise copy the home through a
  // temporary directory, on every release, forever.
  const dir = await containerDir();
  const { run, calls } = makeRunner({
    answers: [
      { match: /^podman --version/, result: ok("4.9.3\n") },
      { match: /^podman image exists/, result: ok() },
      { match: /^podman image inspect/, result: ok("older-digest\n") },
      { match: /^podman container exists/, result: ok() },
      {
        match: /^podman container inspect --format \{\{range .Mounts\}\}/,
        result: ok(`${VM_WORKDIR}=volume\n`),
      },
      { match: /^podman container inspect/, result: ok(containerFacts()) },
      { match: /^podman stop/, result: ok() },
      { match: /^podman rm/, result: ok() },
      { match: /^podman build/, result: ok("built\n") },
      { match: /^podman create /, result: ok("abc123\n") },
      { match: /^podman start/, result: ok() },
      { match: /printf .*DISPLAY/, result: ok(CONTRACT_OK) },
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
      joined.filter((c) => c.startsWith("podman cp")).length,
      0,
      `an already-migrated machine must not copy: ${joined.join("\n")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
