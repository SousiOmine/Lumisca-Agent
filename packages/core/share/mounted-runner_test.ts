import { assertEquals, assertRejects } from "@std/assert";
import type { RunOptions, ShellRunResult } from "../tools/command-backend.ts";
import { shareRootOf } from "./grant.ts";
import { MountedRunner } from "./mounted-runner.ts";
import { answerOf, grantOf, RecordingTransport } from "./test-utils.ts";

const result: ShellRunResult = {
  exitCode: 0,
  stdout: "primary\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 1,
  timedOut: false,
  orphanedOutput: false,
};

const primary = {
  calls: [] as RunOptions[],
  run(_command: string, options: RunOptions) {
    primary.calls.push(options);
    return Promise.resolve(result);
  },
};

function options(cwd: string): RunOptions {
  return { cwd, timeoutSec: 5, maxOutputChars: 1000 };
}

Deno.test("a command outside a lent folder runs where the session works", async () => {
  primary.calls.length = 0;
  const transport = new RecordingTransport(answerOf);
  const runner = new MountedRunner(primary, transport, () => [
    grantOf({ name: "proj", exec: true }),
  ]);
  const answer = await runner.run("ls", options("/home/agent"));
  assertEquals(answer.stdout, "primary\n");
  assertEquals(primary.calls.length, 1);
  assertEquals(transport.calls.length, 0);
});

Deno.test("a command in a lent folder runs on the computer that lent it", async () => {
  primary.calls.length = 0;
  const transport = new RecordingTransport(answerOf);
  const runner = new MountedRunner(primary, transport, () => [
    grantOf({ name: "proj", exec: true }),
  ]);
  const answer = await runner.run("pwd", {
    ...options(`${shareRootOf("proj")}/src`),
    env: { A: "1" },
  });
  assertEquals(answer.stdout, "ok\n");
  assertEquals(primary.calls.length, 0);
  assertEquals(transport.calls[0]?.grantId, "g1");
  assertEquals(transport.last(), {
    op: "exec",
    path: ["src"],
    command: "pwd",
    timeoutSec: 5,
    maxOutputChars: 1000,
    env: { A: "1" },
  });
});

Deno.test("a folder lent without commands refuses instead of running elsewhere", async () => {
  primary.calls.length = 0;
  const transport = new RecordingTransport(answerOf);
  const runner = new MountedRunner(primary, transport, () => [
    grantOf({ name: "proj", exec: false }),
  ]);
  await assertRejects(
    () => runner.run("rm -rf .", options(shareRootOf("proj"))),
    Error,
    "without command access",
  );
  // Neither machine ran it: the refusal is the whole outcome.
  assertEquals(primary.calls.length, 0);
  assertEquals(transport.calls.length, 0);
});
