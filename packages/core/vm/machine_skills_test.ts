import { assertEquals, assertStringIncludes } from "@std/assert";
import type { VmCommandBytesRunner, VmCommandRunner } from "./command.ts";
import type { VmManager, VmStatus } from "./container.ts";
import { StellaMachine } from "./machine.ts";

/**
 * The machine's skill catalog must never stay empty.
 *
 * A catalog read happens when a conversation opens (`refreshSkills`) and the
 * cache is per process, so a server that restarted had none: a routine opens
 * its conversation with the synchronous `openSession`, which never primes
 * one, and the run that followed told its agent that no skills existed. The
 * same run kept the conversation in that state for as long as it stayed
 * open. These tests pin the two halves of the repair: a cold cache reads
 * itself when someone asks for it, and a read that fails is not turned into
 * an error the run has to survive.
 */

const RUNNING: VmStatus = { state: "running", vncPort: 49153, reason: "" };

/** The manager the machine holds; nothing here starts desktops. */
function fakeManager(): VmManager {
  return {
    status: () => Promise.resolve(RUNNING),
    start: () => Promise.resolve(RUNNING),
    stop: () => Promise.resolve(),
    vncPort: () => Promise.resolve(RUNNING.vncPort),
    startDesktop: () => Promise.resolve(),
    stopDesktop: () => Promise.resolve(),
  };
}

/** A SKILL.md the discovery accepts: the name must match the directory. */
const AGENT_SKILL = [
  "---",
  "name: mine",
  "description: the skill this agent wrote",
  "---",
  "Body of the skill.",
].join("\n");

/** The command runner the exec seams sit on: one exec lists the agent's own
 * skill folder and one lists the machine's shared folder (see
 * vm/skills.ts), so this answers a skill for the former and nothing for the
 * latter. `failure` makes every call reject, the way a container that is
 * restarting answers. */
function skillRunner(): {
  run: VmCommandRunner;
  runBytes: VmCommandBytesRunner;
  calls: readonly string[][];
  listings: () => number;
  failure: { value: Error | undefined };
} {
  const calls: string[][] = [];
  const failure: { value: Error | undefined } = { value: undefined };
  const run: VmCommandRunner = (command) => {
    calls.push([...command]);
    if (failure.value !== undefined) return Promise.reject(failure.value);
    const dir = command[command.length - 1] ?? "";
    const stdout = dir.includes("/agents/")
      ? `\n__SKILL__mine\n${AGENT_SKILL}`
      : "";
    return Promise.resolve({
      exitCode: 0,
      stdout,
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  return {
    run,
    runBytes: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: "",
        truncated: false,
        timedOut: false,
      }),
    calls,
    // Every listing is one `podman exec` over `sh -c`; a skill read by name
    // would be another, and this catalog has not been read by name.
    listings: () => calls.length,
    failure,
  };
}

function machineWith(runner?: ReturnType<typeof skillRunner>): StellaMachine {
  return new StellaMachine([], runner === undefined ? undefined : runner);
}

/** Wait until the scheduled read (see StellaMachine.skills) has settled. The
 * wait is bounded so a read that never starts fails the test instead of
 * hanging it. */
async function settled(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the skill catalog read did not settle");
}

Deno.test("a cold catalog reads itself instead of staying empty", async () => {
  const runner = skillRunner();
  const stella = machineWith(runner);
  stella.set(fakeManager());

  // The factory builds the catalog's users synchronously, so the first ask
  // after a restart is answered from an empty cache.
  assertEquals(stella.skills("agent-1"), []);
  await settled(() => stella.skills("agent-1").length > 0);

  const names = stella.skills("agent-1").map((skill) => skill.name);
  assertStringIncludes(names.join(","), "mine");
  // The machine's own skill is not the whole catalog: the app's built-ins
  // are merged in, which is why an empty catalog is always a cold cache and
  // never a machine without skills.
  assertEquals(names.includes("coding-agents"), true);
  assertEquals(runner.listings(), 2);
});

Deno.test("a run and the skill tool asking together share one read", async () => {
  const runner = skillRunner();
  const stella = machineWith(runner);
  stella.set(fakeManager());

  // Both callers see the empty cache before anything settles: the read is
  // the same one.
  await Promise.all([
    stella.ensureSkills("agent-1"),
    stella.ensureSkills("agent-1"),
    Promise.resolve(stella.skills("agent-1")),
  ]);

  assertEquals(runner.listings(), 2);
  assertEquals(stella.skills("agent-1").length > 0, true);
});

Deno.test("without a machine nothing is read and nothing is promised", async () => {
  const runner = skillRunner();
  const stella = machineWith(runner);
  // No `set`: this installation has no virtual machine (code mode only).
  assertEquals(stella.skills("agent-1"), []);
  await stella.ensureSkills("agent-1");
  assertEquals(runner.calls.length, 0);
  assertEquals(stella.skills("agent-1"), []);
});

Deno.test("a failed read does not fail the run and is not retried at once", async () => {
  const runner = skillRunner();
  const stella = machineWith(runner);
  stella.set(fakeManager());
  runner.failure.value = new Error("container state improper");

  // A conversation whose machine is restarting runs without skills; it must
  // not fail to run because its catalog is missing.
  await stella.ensureSkills("agent-1");
  assertEquals(stella.skills("agent-1"), []);
  // One read is one exec per folder (the agent's own and the shared one).
  const afterFirst = runner.listings();
  assertEquals(afterFirst, 2);

  // The skilling tool asks on every call, and a run asks once: the retry
  // waits (SKILL_READ_RETRY_MS) so a machine that is down is not exec'd per
  // call.
  await stella.ensureSkills("agent-1");
  assertEquals(runner.listings(), afterFirst);
});
