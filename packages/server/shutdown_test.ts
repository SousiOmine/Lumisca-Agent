import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createShutdown,
  exitCodeForSignal,
  type ShutdownSignal,
} from "./shutdown.ts";

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A shutdown whose drain is controlled by the test. */
function harness(
  options: {
    drain?: () => Promise<void>;
    graceMs?: number;
  } = {},
) {
  const exits: number[] = [];
  const signals: ShutdownSignal[] = [];
  const errors: string[] = [];
  const shutdown = createShutdown({
    dispose: options.drain ?? (() => Promise.resolve()),
    exit: (code) => void exits.push(code),
    graceMs: options.graceMs ?? 1_000,
    onSignal: (signal) => void signals.push(signal),
    onError: (message) => void errors.push(message),
  });
  return { shutdown, exits, signals, errors };
}

Deno.test("a supervisor's stop is a clean exit, an interrupt is 130", () => {
  // systemd reads the exit code: SIGTERM must look like a clean stop (and
  // Restart=always brings the server back after an applied update), while an
  // interactive Ctrl+C reports the shell convention.
  assertEquals(exitCodeForSignal("SIGTERM"), 0);
  assertEquals(exitCodeForSignal("SIGINT"), 130);
});

Deno.test("the drain is awaited before the process exits", async () => {
  let released = false;
  const test = harness({
    drain: async () => {
      await delay(5);
      released = true;
    },
  });
  test.shutdown("SIGTERM");
  assertEquals(released, false, "the exit must not race the drain");
  await delay(20);
  assertEquals(released, true);
  assertEquals(test.exits, [0]);
  assertEquals(test.signals, ["SIGTERM"]);
  assertEquals(test.errors, []);
});

Deno.test("a drain that overruns is bounded by the grace budget", async () => {
  // A child ignoring its signal must not keep the process alive; the unit's
  // TimeoutStopSec=10 is the outer bound.
  const test = harness({ drain: () => new Promise(() => {}), graceMs: 5 });
  test.shutdown("SIGTERM");
  await delay(30);
  assertEquals(test.exits, [0]);
  assertEquals(test.errors.length, 1);
  assertStringIncludes(test.errors[0]!, "強制終了");
});

Deno.test("a second signal stops waiting for the drain", () => {
  const test = harness({ drain: () => new Promise(() => {}), graceMs: 10_000 });
  test.shutdown("SIGTERM");
  assertEquals(test.exits, []);
  // The operator insists: the code stays the one the first signal decided.
  test.shutdown("SIGINT");
  assertEquals(test.exits, [0]);
});

Deno.test("a failing drain is reported in the log, not as an exit code", async () => {
  const test = harness({
    drain: () => Promise.reject(new Error("database is locked")),
  });
  test.shutdown("SIGTERM");
  await delay(20);
  assertEquals(test.exits, [0]);
  assertStringIncludes(test.errors.join("\n"), "database is locked");
});

Deno.test("the exit code follows the first signal and is reported once", async () => {
  const test = harness();
  test.shutdown("SIGINT");
  await delay(20);
  // A late second signal (the drain already finished) must not exit twice.
  test.shutdown("SIGTERM");
  assertEquals(test.exits, [130]);
});
