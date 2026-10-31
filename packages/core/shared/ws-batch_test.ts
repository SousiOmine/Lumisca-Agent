import { assert, assertEquals } from "@std/assert";
import {
  createFrameBatcher,
  type DeltaFrame,
  WS_DELTA_FLUSH_MS,
  WS_DELTA_MAX_CHARS,
} from "./ws-batch.ts";

/**
 * The delta batcher's contract: several deltas of one session leave as one
 * frame, two sessions never merge into one frame, the batch reports the LAST
 * revision it contains and how many events it covers, an empty delta
 * contributes nothing, a flush emits exactly once, and close() flushes (text
 * already produced must not be dropped when a socket goes away).
 *
 * A manual timer collects what the batcher scheduled, so the tests never wait
 * for the real interval.
 */

function harness(flushMs?: number) {
  const frames: DeltaFrame<string, number>[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const batcher = createFrameBatcher<string, number>({
    flush: (frame) => frames.push(frame),
    ...(flushMs === undefined ? {} : { flushMs }),
    setTimer: (fn, ms) => {
      const handle = { id: timers.length };
      timers.push({ fn, ms });
      return handle;
    },
    clearTimer: (handle) => cleared.push(handle),
  });
  const timeoutMs = (): number | undefined => timers.at(-1)?.ms;
  return { batcher, frames, timers, cleared, timeoutMs };
}

Deno.test("ws-batch: several deltas of one session leave as one frame", () => {
  const { batcher, frames } = harness();
  batcher.delta("s1", "Hel");
  batcher.delta("s1", "lo ");
  batcher.delta("s1", "world");
  assertEquals(frames, []);
  batcher.flush();
  assertEquals(frames, [
    { key: "s1", delta: "Hello world", rev: undefined, events: 3 },
  ]);
});

Deno.test("ws-batch: two sessions are never merged into one frame", () => {
  // One socket carries every open tab's events. Concatenating two tabs'
  // tokens would hand each viewer the other tab's words.
  const { batcher, frames } = harness();
  batcher.delta("s1", "first");
  batcher.delta("s2", "second");
  batcher.flush();
  assertEquals(frames, [
    { key: "s1", delta: "first", rev: undefined, events: 1 },
    { key: "s2", delta: "second", rev: undefined, events: 1 },
  ]);
});

Deno.test("ws-batch: the timer flushes the buffered deltas", () => {
  const { batcher, frames, timers, timeoutMs } = harness();
  batcher.delta("s1", "a");
  assertEquals(timers.length, 1);
  // One display frame: fine enough that the reader cannot see the wait.
  assertEquals(timeoutMs(), WS_DELTA_FLUSH_MS);
  timers[0]!.fn();
  assertEquals(frames, [{ key: "s1", delta: "a", rev: undefined, events: 1 }]);
});

Deno.test("ws-batch: the timer starts with the first delta only", () => {
  const { batcher, timers } = harness();
  batcher.delta("s1", "a");
  batcher.delta("s1", "b");
  batcher.delta("s2", "c");
  // A delta joining the batch must not restart (or add) a timer: that would
  // push the flush back by one interval per token and stall the flow.
  assertEquals(timers.length, 1);
});

Deno.test("ws-batch: a batch reports the last revision it contains", () => {
  // The revision is a count of events, not of frames: a batch of three
  // deltas has to report the third's revision, or the client would read a
  // gap and re-fetch the snapshot on every batch.
  const { batcher, frames } = harness();
  batcher.delta("s1", "a", 11);
  batcher.delta("s1", "b", 12);
  batcher.delta("s1", "c", 13);
  batcher.flush();
  assertEquals(frames, [
    { key: "s1", delta: "abc", rev: 13, events: 3 },
  ]);
});

Deno.test("ws-batch: an empty delta contributes nothing", () => {
  const { batcher, frames, timers } = harness();
  batcher.delta("s1", "", 1);
  // No text, no timer: an empty delta must not start a flush loop.
  assertEquals(timers.length, 0);
  batcher.flush();
  assertEquals(frames, []);
  assertEquals(batcher.pending, false);
});

Deno.test("ws-batch: flush twice emits once", () => {
  // The caller flushes before every non-delta frame, and those can arrive in
  // a row; a second flush must not emit an empty frame.
  const { batcher, frames } = harness();
  batcher.delta("s1", "x");
  batcher.flush();
  batcher.flush();
  assertEquals(frames, [{ key: "s1", delta: "x", rev: undefined, events: 1 }]);
});

Deno.test("ws-batch: a large batch flushes without waiting", () => {
  // A fast model must not build one unbounded frame: past maxChars the batch
  // goes out immediately, even though the interval has not elapsed.
  const { batcher, frames, timers } = harness();
  batcher.delta("s1", "x".repeat(WS_DELTA_MAX_CHARS));
  assertEquals(frames.length, 1);
  assertEquals(frames[0]!.delta.length, WS_DELTA_MAX_CHARS);
  // The timer that was started for it is no longer needed.
  assertEquals(timers.length, 1);
  assertEquals(batcher.pending, false);
});

Deno.test("ws-batch: a large batch does not strand another session", () => {
  const { batcher, frames } = harness();
  batcher.delta("s1", "a");
  batcher.delta("s2", "x".repeat(WS_DELTA_MAX_CHARS));
  // s2 went out on its own; s1 is still waiting for the interval.
  assertEquals(frames.map((frame) => frame.key), ["s2"]);
  batcher.flush();
  assertEquals(frames.map((frame) => frame.key), ["s2", "s1"]);
});

Deno.test("ws-batch: close flushes what was produced, then stops", () => {
  // A socket closing mid-stream must not silently drop text the model
  // already produced.
  const { batcher, frames } = harness();
  batcher.delta("s1", "tail");
  batcher.close();
  assertEquals(frames, [
    { key: "s1", delta: "tail", rev: undefined, events: 1 },
  ]);
  batcher.delta("s1", "after");
  batcher.flush();
  assertEquals(frames.length, 1);
});

Deno.test("ws-batch: close cancels the pending timer", () => {
  const { batcher, timers, cleared } = harness();
  batcher.delta("s1", "a");
  batcher.close();
  assertEquals(cleared.length, 1);
  // The scheduled callback must not fire into a closed batcher (it would
  // emit after the socket is gone).
  timers[0]!.fn();
  assertEquals(batcher.pending, false);
});

Deno.test("ws-batch: pending tracks the buffer", () => {
  const { batcher } = harness();
  assertEquals(batcher.pending, false);
  batcher.delta("s1", "a");
  assertEquals(batcher.pending, true);
  batcher.flush();
  assertEquals(batcher.pending, false);
});

Deno.test("ws-batch: a flush timer that fires after a manual flush is inert", () => {
  const { batcher, frames, timers } = harness();
  batcher.delta("s1", "a");
  batcher.flush();
  // The timer was cleared, but a real one could already be queued; firing it
  // must not emit a second (empty) frame.
  timers[0]!.fn();
  assertEquals(frames, [{ key: "s1", delta: "a", rev: undefined, events: 1 }]);
  assert(frames.every((frame) => frame.delta.length > 0));
});
