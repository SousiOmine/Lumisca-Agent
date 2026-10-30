import { assertEquals } from "@std/assert";
import { formatDuration } from "./duration.ts";

/** `formatDuration` is one pure formatter with four output bands. The bands
 * share the point of the function (a duration a person can read at a glance)
 * so they are checked together, with the band edges kept explicit: the
 * edges are what a rewrite breaks, not the middle of a band. */

Deno.test("formatDuration picks the band and keeps its edges readable", () => {
  // Sub-second: milliseconds, rounded down.
  assertEquals(formatDuration(0), "0ms");
  assertEquals(formatDuration(12.4), "12ms");
  assertEquals(formatDuration(420), "420ms");
  assertEquals(formatDuration(999), "999ms");

  // One decimal below ten seconds...
  assertEquals(formatDuration(1000), "1.0s");
  assertEquals(formatDuration(1383), "1.4s");
  assertEquals(formatDuration(9870), "9.9s");
  // ...including a value that rounds up across the boundary: it must read
  // like a plain ten seconds, not print "10.0s", which the band below never
  // produces.
  assertEquals(formatDuration(999.7), "1.0s");
  assertEquals(formatDuration(9997), "10s");

  // Whole seconds, then minutes and hours with zero padding.
  assertEquals(formatDuration(10_400), "10s");
  assertEquals(formatDuration(12_400), "12s");
  assertEquals(formatDuration(59_600), "1m 00s");
  assertEquals(formatDuration(125_000), "2m 05s");
  assertEquals(formatDuration(3_600_000), "1h 00m 00s");
  assertEquals(formatDuration(3_661_000), "1h 01m 01s");
});

Deno.test("formatDuration clamps a negative duration to zero", () => {
  // A clock correction can put the end before the start; "-5ms" would be
  // shown to the user.
  assertEquals(formatDuration(-5), "0ms");
});
