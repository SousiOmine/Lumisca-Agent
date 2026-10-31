import { assertEquals, assertRejects } from "@std/assert";
import { VmBackgroundSpawner, VmCommandRunner } from "./shell.ts";
import { shellQuote } from "./quote.ts";
import type { VmExec, VmExecOptions } from "./container.ts";
import type { VmCommandResult } from "./command.ts";

/** A scripted exec seam with per-call answers, so a spawn's follow-up
 * liveness probes can answer differently from its start. */
function exec(
  handler: (joined: string, calls: number) => Partial<VmCommandResult>,
): { run: VmExec; calls: string[][] } {
  const calls: string[][] = [];
  let count = 0;
  return {
    calls,
    run: (command, _options: VmExecOptions) => {
      const argv = [...command];
      calls.push(argv);
      count++;
      return Promise.resolve<VmCommandResult>({
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        ...handler(argv.join(" "), count),
      });
    },
  };
}

// --- the foreground runner -------------------------------------------------

Deno.test("vm shell: the runner wraps the command in one login shell", async () => {
  const { run, calls } = exec(() => ({ stdout: "output\n" }));
  const runner = new VmCommandRunner(run);
  const result = await runner.run("echo hi", {
    cwd: "/home/agent",
    timeoutSec: 5,
    maxOutputChars: 4096,
  });
  assertEquals(result.stdout, "output\n");
  assertEquals(result.exitCode, 0);
  const [argv] = calls;
  // One login shell, with the command as a single argument: nothing in it is
  // re-interpreted, so a command that works in the host's bash works here.
  assertEquals(argv?.slice(0, 3), ["bash", "-lc", "echo hi"]);
});

Deno.test("vm shell: per-call env vars travel through env, quoted", async () => {
  const { run, calls } = exec(() => ({}));
  const runner = new VmCommandRunner(run);
  await runner.run("printenv", {
    cwd: "/home/agent",
    timeoutSec: 5,
    maxOutputChars: 4096,
    env: { GREETING: "it's fine" },
  });
  const script = calls[0]?.[2] ?? "";
  assertEquals(script, `env GREETING='it'\\''s fine' printenv`);
});

Deno.test("vm shell: a timeout is reported, not thrown", async () => {
  const { run } = exec(() => ({ exitCode: 124, timedOut: true }));
  const runner = new VmCommandRunner(run);
  const result = await runner.run("sleep 100", {
    cwd: "/home/agent",
    timeoutSec: 1,
    maxOutputChars: 1024,
  });
  assertEquals(result.timedOut, true);
  // The container call's pipes close with the request, so no descendant can
  // hold them: the host-only "orphaned output" state is never reported here.
  assertEquals(result.orphanedOutput, false);
});

// --- the background spawner ------------------------------------------------

Deno.test("vm shell: a background command is started detached with a log", async () => {
  const { run, calls } = exec((joined) => {
    if (joined.includes("setsid")) return { stdout: "4242" };
    if (joined.includes("kill -0")) return { stdout: "gone\n" };
    return { stdout: "" };
  });
  const spawner = new VmBackgroundSpawner(run);
  const process = await spawner.spawn({
    command: "npm run dev",
    cwd: "/home/agent/app",
  });
  assertEquals(process.pid, 4242);
  const start = calls[0]?.join(" ") ?? "";
  // Detached in its own session, output to a per-command log, pid recorded.
  assertEquals(start.includes("setsid"), true);
  assertEquals(start.includes(">>"), true);
  assertEquals(start.includes(".lumisca-bg"), true);
  // The machine is gone, so the completion resolves without waiting.
  assertEquals(await process.exited, undefined);
  await process.kill();
});

Deno.test("vm shell: kill targets the process group", async () => {
  const { run, calls } = exec((joined) => {
    if (joined.includes("setsid")) return { stdout: "777" };
    return {};
  });
  const spawner = new VmBackgroundSpawner(run);
  const process = await spawner.spawn({
    command: "sleep 100",
    cwd: "/home/agent",
  });
  await process.kill();
  const kill = calls.map((call) => call.join(" ")).find((c) =>
    c.includes("kill -TERM")
  );
  assertEquals(kill?.includes("-777"), true);
  // Idempotent: a second kill sends nothing more.
  const before = calls.length;
  await process.kill();
  assertEquals(calls.length, before);
});

Deno.test("vm shell: a failed start reports the machine's message", async () => {
  const { run } = exec(() => ({
    exitCode: 1,
    stderr: "no such directory",
  }));
  const spawner = new VmBackgroundSpawner(run);
  await assertRejects(
    () => spawner.spawn({ command: "x", cwd: "/nope" }),
    Error,
    "Could not start the background command",
  );
});

Deno.test("vm shell: a start without a pid is refused", async () => {
  const { run } = exec(() => ({ stdout: "not-a-pid" }));
  const spawner = new VmBackgroundSpawner(run);
  await assertRejects(
    () => spawner.spawn({ command: "x", cwd: "/home/agent" }),
    Error,
    "no process id",
  );
});

Deno.test({
  name: "vm shell: shellQuote round-trips through a real shell",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // The quoting is the one piece that must be exactly right: a value with
    // a quote in it must reach the command unchanged. Only a POSIX shell can
    // answer this: the VM image has no `sh` at C:\bin, and the quoting the
    // host uses on Windows is PowerShell's, not this one (fs_test covers the
    // strings shellQuote itself produces on every platform).
    const value = 'it\'s a "test"';
    const result = await new Deno.Command("/bin/sh", {
      args: ["-c", `printf '%s' ${shellQuote(value)}`],
    }).output();
    assertEquals(new TextDecoder().decode(result.stdout), value);
  },
});
