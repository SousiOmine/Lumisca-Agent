import { assertEquals } from "@std/assert";
import { MAX_ARRIVALS, newArrivals } from "./useArrivals.ts";

/**
 * The arrival diff decides whether a transcript animates a message or,
 * silently, replays a hundred of them. Both directions matter: a live message
 * that is not flagged just appears (a missing animation), while a loaded
 * window that is flagged stages the whole conversation (the bug). These cases
 * are the two loads — first render, history paging — and the one live path.
 */

Deno.test("newArrivals: the first render is not an arrival", () => {
  // Opening a conversation paints its whole window at once.
  assertEquals(newArrivals(undefined, ["a", "b", "c"]), []);
});

Deno.test("newArrivals: a message appended at the end is the arrival", () => {
  assertEquals(newArrivals(["a", "b"], ["a", "b", "c"]), ["c"]);
  // The user's message and the reply land in one commit for a fast round
  // trip; both are new.
  assertEquals(newArrivals(["a"], ["a", "b", "c"]), ["b", "c"]);
});

Deno.test("newArrivals: a page of history above the window is silent", () => {
  // Paging back inserts older entries at the front: nothing arrived.
  assertEquals(newArrivals(["c", "d"], ["a", "b", "c", "d"]), []);
});

Deno.test("newArrivals: a window that replaced the list is silent", () => {
  // A resync that fell behind by more than a page replaces every row. The
  // whole conversation is "new" to the DOM, which is not an arrival.
  assertEquals(newArrivals(["a", "b"], ["x", "y", "z"]), []);
  // ...and neither is the greeting of a conversation that just opened.
  assertEquals(newArrivals(["x"], ["a", "b", "c", "d", "e"]), []);
});

Deno.test("newArrivals: shrank (a rewind) or unchanged", () => {
  assertEquals(newArrivals(["a", "b", "c"], ["a"]), []);
  assertEquals(newArrivals(["a", "b"], ["a", "b"]), []);
  assertEquals(newArrivals([], []), []);
});

Deno.test("newArrivals: an empty list that gets its first row is an arrival", () => {
  // A conversation opened empty, then the first prompt lands: that row is
  // genuinely new. A whole window arriving at once is not (the cap).
  assertEquals(newArrivals([], ["a"]), ["a"]);
  assertEquals(newArrivals([], ["a", "b", "c"]), ["a", "b", "c"]);
  assertEquals(newArrivals([], ["a", "b", "c", "d"]), []);
});

Deno.test("newArrivals: a batch above the cap is a load, not a live burst", () => {
  const previous = Array.from({ length: 10 }, (_, i) => `m${i}`);
  const batch = Array.from(
    { length: MAX_ARRIVALS + 1 },
    (_, i) => `n${i}`,
  );
  assertEquals(newArrivals(previous, [...previous, ...batch]), []);
  const atCap = batch.slice(0, MAX_ARRIVALS);
  assertEquals(newArrivals(previous, [...previous, ...atCap]), atCap);
});
