import { assertEquals } from "@std/assert";
import { createHeartbeatWatchdog } from "./heartbeat.ts";

/**
 * The watchdog judges the event stream's silence. Its deadline and its
 * judgement are driven by an injected clock and by explicit `check()` calls,
 * never by wall-clock timers: a loaded runner stalls the event loop for tens
 * of milliseconds, and the real-timer version of the first test here reported
 * a live socket as dead on CI (windows-latest, v0.9.1). Driving the clock is
 * also stricter — a `beat()` that stopped moving the deadline is caught by
 * the same run, because the next judgement steps past it.
 *
 * `checkMs` is set out of reach in every case so no interval can slip a
 * judgement in between two assertions.
 */

/** A watchdog over a clock the test moves by hand. */
function watchdog(options: {
  timeoutMs?: number;
  isHidden?: () => boolean;
}) {
  let now = 0;
  let dead = 0;
  const instance = createHeartbeatWatchdog({
    onDead: () => dead++,
    timeoutMs: options.timeoutMs ?? 30,
    checkMs: 3_600_000,
    isHidden: options.isHidden ?? (() => false),
    now: () => now,
  });
  return {
    instance,
    dead: () => dead,
    advance(ms: number) {
      now += ms;
    },
  };
}

Deno.test("heartbeat: silence past the deadline reports the socket dead once", () => {
  const { instance, dead, advance } = watchdog({ timeoutMs: 30 });
  advance(29);
  instance.check();
  assertEquals(dead(), 0, "under the deadline the socket is still alive");
  advance(1);
  instance.check();
  assertEquals(dead(), 1, "a silent socket is reported");
  // Fired once: the caller closes the socket, so a second report would only
  // schedule a redundant reconnect.
  instance.check();
  assertEquals(dead(), 1, "the same death is not reported twice");
  instance.stop();
});

Deno.test("heartbeat: a beating socket is never reported dead", () => {
  const { instance, dead, advance } = watchdog({ timeoutMs: 30 });
  // Any frame counts, not just heartbeats: a busy stream is alive too.
  for (let i = 0; i < 10; i++) {
    advance(20);
    instance.check();
    instance.beat();
  }
  assertEquals(dead(), 0, "the beats keep every judgement under the deadline");
  // The same socket once its frames really stop: still judged.
  advance(30);
  instance.check();
  assertEquals(dead(), 1);
  instance.stop();
});

Deno.test("heartbeat: a hidden page does not judge, and judges on return", () => {
  let hidden = true;
  const { instance, dead, advance } = watchdog({
    timeoutMs: 30,
    isHidden: () => hidden,
  });
  advance(120);
  instance.check();
  assertEquals(dead(), 0, "a hidden page's silence says nothing");
  // Returning to the foreground judges immediately, without waiting for the
  // next interval (connectEvents calls check() on visibilitychange).
  hidden = false;
  instance.check();
  assertEquals(dead(), 1);
  instance.stop();
});

Deno.test("heartbeat: stop ends the watch", () => {
  const { instance, dead, advance } = watchdog({ timeoutMs: 30 });
  instance.stop();
  advance(1_000);
  instance.check();
  assertEquals(dead(), 0, "a stopped watchdog judges nothing");
});
