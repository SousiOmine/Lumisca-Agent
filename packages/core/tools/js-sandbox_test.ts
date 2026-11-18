import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { waitUntil } from "../test-utils.ts";
import { JsSandbox } from "./js-sandbox.ts";

test("sandbox: reset stops the timers its snippets scheduled", async () => {
  // The counter is a host object the snippet bumps synchronously. A file
  // written on every tick is the wrong marker: Bun.write truncates the file
  // before its bytes land, so a read in between sees an empty file, and the
  // test then reports that the interval never ran. The timer, not the
  // write, is what is under test.
  const ticks = { count: 0 };
  const sandbox = new JsSandbox({ globals: { ticks } });
  try {
    await sandbox.run(
      "setInterval(() => { ticks.count++ }, 10); 'armed'",
      5_000,
    );
    await waitUntil(() => ticks.count > 0, "the snippet's interval to tick");

    // reset throws the sandbox (and the closure the interval captured)
    // away; the timer itself must go with it, or it keeps running in the
    // server process for the rest of the session.
    sandbox.reset();
    const settled = ticks.count;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(ticks.count, settled, "the interval kept running after reset");
  } finally {
    sandbox.close();
  }
});
