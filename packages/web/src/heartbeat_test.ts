import { assertEquals } from "@std/assert";
import { createHeartbeatWatchdog } from "./heartbeat.ts";

/** Wait `ms` so the watchdog's real timers can run: the tests drive it with
 * millisecond values instead of the production seconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("heartbeat: silence past the deadline reports the socket dead once", async () => {
  let dead = 0;
  const watchdog = createHeartbeatWatchdog({
    onDead: () => dead++,
    timeoutMs: 15,
    checkMs: 5,
    isHidden: () => false,
  });
  await sleep(80);
  assertEquals(dead, 1, "a silent socket is reported exactly once");
  watchdog.stop();
});

Deno.test("heartbeat: a beating socket is never reported dead", () => {
  // The deadline runs on the injected clock, not on real timers: a loaded
  // runner stalls the event loop for tens of milliseconds, and the
  // real-timer version of this test reported a live socket as dead on CI
  // (windows-latest, v0.9.1). Driving the clock also makes the test
  // stricter: a `beat()` that stopped moving the deadline is caught by the
  // same run, because the next judgement steps past it.
  let dead = 0;
  let now = 0;
  const watchdog = createHeartbeatWatchdog({
    onDead: () => dead++,
    timeoutMs: 30,
    // Never fires: the test calls check() itself, so no wall-clock timer
    // can slip a judgement between two beats.
    checkMs: 3_600_000,
    isHidden: () => false,
    now: () => now,
  });
  // Any frame counts, not just heartbeats: a busy stream is alive too.
  for (let i = 0; i < 10; i++) {
    now += 20;
    watchdog.check();
    watchdog.beat();
  }
  assertEquals(dead, 0, "the beats keep every judgement under the deadline");
  // The same socket once its frames really stop: still judged.
  now += 30;
  watchdog.check();
  assertEquals(dead, 1);
  watchdog.stop();
});

Deno.test("heartbeat: a hidden page does not judge, and judges on return", async () => {
  let hidden = true;
  let dead = 0;
  const watchdog = createHeartbeatWatchdog({
    onDead: () => dead++,
    timeoutMs: 15,
    checkMs: 5,
    isHidden: () => hidden,
  });
  await sleep(60);
  assertEquals(dead, 0, "a hidden page's silence says nothing");
  // Returning to the foreground judges immediately, without waiting for the
  // next interval (connectEvents calls check() on visibilitychange).
  hidden = false;
  watchdog.check();
  assertEquals(dead, 1);
  watchdog.stop();
});

Deno.test("heartbeat: stop ends the watch", async () => {
  let dead = 0;
  const watchdog = createHeartbeatWatchdog({
    onDead: () => dead++,
    timeoutMs: 15,
    checkMs: 5,
    isHidden: () => false,
  });
  watchdog.stop();
  await sleep(60);
  assertEquals(dead, 0);
});
