import { assertEquals } from "@std/assert";
import { formatDuration } from "./duration.ts";

Deno.test("formatDuration keeps sub-second values in milliseconds", () => {
  assertEquals(formatDuration(0), "0ms");
  assertEquals(formatDuration(12.4), "12ms");
  assertEquals(formatDuration(420), "420ms");
  assertEquals(formatDuration(999), "999ms");
});

Deno.test("formatDuration keeps a tenth of a second below ten seconds", () => {
  assertEquals(formatDuration(1000), "1.0s");
  assertEquals(formatDuration(1383), "1.4s");
  assertEquals(formatDuration(999.7), "1.0s");
  assertEquals(formatDuration(9870), "9.9s");
  // Rounding up to ten seconds must read like a plain ten seconds, not
  // print a value the whole-second band would never produce.
  assertEquals(formatDuration(9997), "10s");
});

Deno.test("formatDuration reports seconds, minutes and hours", () => {
  assertEquals(formatDuration(10_400), "10s");
  assertEquals(formatDuration(12_400), "12s");
  assertEquals(formatDuration(59_600), "1m 00s");
  assertEquals(formatDuration(125_000), "2m 05s");
  assertEquals(formatDuration(3_600_000), "1h 00m 00s");
  assertEquals(formatDuration(3_661_000), "1h 01m 01s");
});

Deno.test("formatDuration clamps a negative duration to zero", () => {
  assertEquals(formatDuration(-5), "0ms");
});
