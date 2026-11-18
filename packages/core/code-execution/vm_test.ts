import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { VmChannel, VmChannelOptions } from "../vm/channel.ts";
import type { VmExec, VmExecOptions } from "../vm/container.ts";
import { createVmCodeRuntime } from "./vm.ts";

/**
 * The machine-side program cannot be run here (no `node` on the host, and
 * the machine is not this machine), so these tests drive the SERVER half:
 * the lines a program would send, and what the runtime answers. The real
 * round trip is covered by the live test on a machine.
 */
function fakeExec(): { exec: VmExec; writes: string[] } {
  const writes: string[] = [];
  const exec: VmExec = (command, options: VmExecOptions) => {
    if (options.stdin !== undefined) {
      writes.push(new TextDecoder().decode(options.stdin));
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  return { exec, writes };
}

interface FakeChannel {
  channel: VmChannel;
  written: string[];
  opened: string[];
  killed: boolean;
}

function fakeChannel(
  lines: readonly (string | undefined)[],
  exitCode = 0,
): FakeChannel {
  const written: string[] = [];
  const opened: string[] = [];
  const state = { killed: false };
  let index = 0;
  return {
    written,
    opened,
    get killed() {
      return state.killed;
    },
    channel: {
      write(line: string) {
        written.push(line);
        return Promise.resolve();
      },
      read() {
        const line = lines[index++];
        return Promise.resolve(line);
      },
      stderr: () => "",
      exitCode: () => exitCode,
      kill() {
        state.killed = true;
      },
    },
  };
}

function makeRuntime(fake: FakeChannel, execWrites: { exec: VmExec }) {
  return createVmCodeRuntime({
    exec: execWrites.exec,
    cwd: "/home/agent",
    channel: (command: readonly string[], _options: VmChannelOptions) => {
      (fake.opened as string[]).push(command.join(" "));
      return Promise.resolve(fake.channel);
    },
  });
}

test("vm runtime: a tool call is answered over the channel", async () => {
  const fake = fakeChannel([
    JSON.stringify({ type: "call", id: 1, name: "read", args: { path: "a" } }),
    JSON.stringify({ type: "done", value: { ok: true } }),
  ]);
  const { exec, writes } = fakeExec();
  const runtime = makeRuntime(fake, { exec });
  const calls: string[] = [];
  const outcome = await runtime.run("return 1", {
    timeoutMs: 5_000,
    call: (name, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return Promise.resolve({ text: "file body", images: [] });
    },
  });
  assertEquals(calls, ['read:{"path":"a"}']);
  assertEquals(outcome.value, { ok: true });
  const answer = JSON.parse(fake.written[0]!);
  assertEquals(answer.type, "result");
  assertEquals(answer.ok, true);
  assertEquals(answer.text, "file body");
  // The program file was written for the machine, with the program in it.
  assertEquals(writes.length, 1);
  assert(writes[0]!.includes("return 1"), writes[0]);
  assert(writes[0]!.includes("callTool"), "the protocol prelude must be there");
});

test("vm runtime: a failing tool answers with its message", async () => {
  const fake = fakeChannel([
    JSON.stringify({ type: "call", id: 7, name: "bash" }),
    JSON.stringify({ type: "done", value: null }),
  ]);
  const { exec } = fakeExec();
  const runtime = makeRuntime(fake, { exec });
  await runtime.run("return 1", {
    timeoutMs: 5_000,
    call: () => Promise.reject(new Error("exit code 1")),
  });
  const answer = JSON.parse(fake.written[0]!);
  assertEquals(answer.ok, false);
  assertEquals(answer.error, "exit code 1");
});

test("vm runtime: a program error is the run's error", async () => {
  const fake = fakeChannel([
    JSON.stringify({ type: "error", message: "boom" }),
  ]);
  const { exec } = fakeExec();
  const runtime = makeRuntime(fake, { exec });
  await assertRejects(
    () =>
      runtime.run("throw new Error('boom')", {
        timeoutMs: 5_000,
        call: () => Promise.resolve({ text: "", images: [] }),
      }),
    Error,
    "boom",
  );
});

test("vm runtime: a program killed by its timeout says so", async () => {
  const fake = fakeChannel([], 124);
  const { exec } = fakeExec();
  const runtime = makeRuntime(fake, { exec });
  await assertRejects(
    () =>
      runtime.run("while (true) {}", {
        timeoutMs: 30_000,
        call: () => Promise.resolve({ text: "", images: [] }),
      }),
    Error,
    "exceeded its 30s limit",
  );
});

test("vm runtime: a stopped run stops the program", async () => {
  const fake = fakeChannel([]);
  const { exec } = fakeExec();
  const runtime = makeRuntime(fake, { exec });
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () =>
      runtime.run("return 1", {
        timeoutMs: 5_000,
        signal: controller.signal,
        call: () => Promise.resolve({ text: "", images: [] }),
      }),
    Error,
  );
});

test("vm runtime: the channel is opened under the program's timeout", async () => {
  const fake = fakeChannel([JSON.stringify({ type: "done", value: 1 })]);
  const { exec } = fakeExec();
  const runtime = makeRuntime(fake, { exec });
  await runtime.run("return 1", {
    timeoutMs: 65_000,
    call: () => Promise.resolve({ text: "", images: [] }),
  });
  assertEquals(fake.opened.length, 1);
  // Seconds, not milliseconds: `timeout` inside the machine takes seconds.
  assert(fake.opened[0]!.includes("timeout -k 5 65"), fake.opened[0]);
});
