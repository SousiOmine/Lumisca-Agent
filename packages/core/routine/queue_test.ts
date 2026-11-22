import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { RoutineQueue } from "./queue.ts";

/**
 * The counting a routine's runs are kept in: one run at a time, at most one
 * waiting behind it, and the two marks a stop leaves. The scheduler's tests
 * cover the behaviour end to end; these pin the states the settings list
 * draws and the marks a stop depends on.
 */

function queue(): {
  queue: RoutineQueue;
  time: () => number;
  advance: () => void;
} {
  let value = 1_000;
  return {
    queue: new RoutineQueue(() => value),
    time: () => value,
    advance: () => {
      value += 100;
    },
  };
}

test("a fresh routine is idle and takes the waiting slot once", () => {
  const { queue: q } = queue();
  assertEquals(q.stateOf("r1"), "idle");
  assertEquals(q.isBusy("r1"), false);
  assertEquals(q.beginWait("r1"), true);
  assertEquals(q.stateOf("r1"), "queued");
  assertEquals(q.isBusy("r1"), true);
  // A second occurrence while one waits is one too many.
  assertEquals(q.beginWait("r1"), false);
  assertEquals(q.stateOf("r1"), "queued");
});

test("the wait records when it started, and a run replaces it", () => {
  const { queue: q, time, advance } = queue();
  q.beginWait("r1");
  assertEquals(q.waitingSince("r1"), time());
  advance();
  q.beginRun("r1");
  assertEquals(q.stateOf("r1"), "running");
  assertEquals(q.waitingSince("r1"), undefined);
  q.endRun("r1");
  assertEquals(q.stateOf("r1"), "idle");
});

test("ending a run that never started leaves nothing behind", () => {
  const { queue: q } = queue();
  q.beginWait("r1");
  q.endRun("r1");
  assertEquals(q.stateOf("r1"), "idle");
  assertEquals(q.isBusy("r1"), false);
});

test("a cancellation is a one-time fact about a waiting run", () => {
  const { queue: q } = queue();
  // Nothing waiting: nothing to cancel.
  assertEquals(q.cancelWaiting("r1"), false);
  q.beginWait("r1");
  assertEquals(q.cancelWaiting("r1"), true);
  assertEquals(q.takeCancelled("r1"), true);
  // Consumed: the next run of the same routine is not cancelled.
  assertEquals(q.takeCancelled("r1"), false);
});

test("a stop mark belongs to a running run only", () => {
  const { queue: q } = queue();
  // A routine that is not running cannot be marked as stopped.
  assertEquals(q.markRunningStopped("r1"), false);
  q.beginWait("r1");
  q.beginRun("r1");
  assertEquals(q.markRunningStopped("r1"), true);
  assertEquals(q.takeStopped("r1"), true);
  assertEquals(q.takeStopped("r1"), false);
});

test("a stop mark nobody consumed does not outlive its run", () => {
  const { queue: q } = queue();
  q.beginWait("r1");
  q.beginRun("r1");
  q.markRunningStopped("r1");
  q.forgetStopped("r1");
  assertEquals(q.takeStopped("r1"), false);
});

test("two routines are counted apart", () => {
  const { queue: q } = queue();
  q.beginWait("r1");
  q.beginWait("r2");
  q.beginRun("r2");
  assertEquals(q.stateOf("r1"), "queued");
  assertEquals(q.stateOf("r2"), "running");
});
