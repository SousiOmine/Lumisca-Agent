import { assert, assertEquals } from "@std/assert";
import {
  createReconnectScheduler,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "./reconnect.ts";

/** Record the delays the scheduler asks for and run each callback when the
 * test says so, without waiting for real time. */
function withFakeTimers(): {
  delays: number[];
  /** Run the pending attempt (as the browser would after the delay). */
  fire: () => void;
  restore: () => void;
} {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    pending = fn;
    return 0 as unknown as number;
  }) as typeof globalThis.setTimeout;
  return {
    delays,
    fire: () => {
      const next = pending;
      pending = undefined;
      next?.();
    },
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

Deno.test("reconnect: the wait doubles per failure and stops at the cap", () => {
  const timers = withFakeTimers();
  try {
    const scheduler = createReconnectScheduler();
    // Each attempt schedules the next, the way a failing stream does.
    const attempt = () => scheduler.schedule(attempt);
    scheduler.schedule(attempt);
    for (let i = 1; i < 8; i++) timers.fire();
    assertEquals(timers.delays[0], RECONNECT_BASE_MS);
    assertEquals(timers.delays[1], RECONNECT_BASE_MS * 2);
    assertEquals(timers.delays[2], RECONNECT_BASE_MS * 4);
    // The cap holds however many attempts pile up: an unbounded exponent
    // would eventually schedule a retry millennia away (and overflow to
    // Infinity before that).
    assertEquals(timers.delays.at(-1), RECONNECT_MAX_MS);
  } finally {
    timers.restore();
  }
});

Deno.test("reconnect: a second schedule while one is pending is ignored", () => {
  const timers = withFakeTimers();
  try {
    const scheduler = createReconnectScheduler();
    scheduler.schedule(() => {});
    scheduler.schedule(() => {});
    assertEquals(timers.delays.length, 1);
  } finally {
    timers.restore();
  }
});

Deno.test("reconnect: a successful connection resets the backoff", () => {
  const timers = withFakeTimers();
  try {
    const scheduler = createReconnectScheduler();
    const attempt = () => scheduler.schedule(attempt);
    scheduler.schedule(attempt);
    timers.fire();
    assertEquals(timers.delays.at(-1), RECONNECT_BASE_MS * 2);
    // The stream came back: the count starts over, so the next failure waits
    // the base delay again instead of the doubled one.
    scheduler.cancel();
    scheduler.reset();
    scheduler.schedule(attempt);
    assertEquals(timers.delays.at(-1), RECONNECT_BASE_MS);
  } finally {
    timers.restore();
  }
});

Deno.test("reconnect: a closed stream schedules nothing", () => {
  const timers = withFakeTimers();
  try {
    let closed = false;
    const scheduler = createReconnectScheduler({ stopped: () => closed });
    scheduler.schedule(() => {});
    closed = true;
    scheduler.schedule(() => {});
    assertEquals(timers.delays.length, 1);
  } finally {
    timers.restore();
  }
});

Deno.test("reconnect: cancel drops the pending attempt", () => {
  const original = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.clearTimeout = ((id: number) => {
    cleared++;
    return original(id);
  }) as typeof globalThis.clearTimeout;
  try {
    const scheduler = createReconnectScheduler({
      baseMs: 1,
      maxMs: 1,
    });
    let ran = 0;
    scheduler.schedule(() => ran++);
    scheduler.cancel();
    assertEquals(cleared, 1, "the pending timer was cleared");
    assertEquals(ran, 0, "the cancelled attempt never ran");
    // A cancelled scheduler is not stuck: the next failure schedules again.
    scheduler.schedule(() => {});
    assert(true);
  } finally {
    globalThis.clearTimeout = original;
  }
});
