/**
 * Which mode a bare `/` starts in.
 *
 * The desktop shell, an installed PWA and a plain bookmark all open `/`, and
 * that address has to answer a mode on its own: a first launch starts in the
 * main mode (Lumisca) rather than at a chooser, and a client that has chosen
 * before starts where it left off.
 */
import { assertEquals } from "@std/assert";
import { MAIN_MODE, startModeOf } from "./useAppMode.ts";

Deno.test("startModeOf: a client that never chose starts in the main mode", () => {
  assertEquals(MAIN_MODE, "stella");
  assertEquals(startModeOf(null), "stella");
});

Deno.test("startModeOf: a stored mode is the answer", () => {
  assertEquals(startModeOf("stella"), "stella");
  assertEquals(startModeOf("code"), "code");
});

Deno.test("startModeOf: an unknown value is the same as no choice", () => {
  // An older spelling, a hand-edited entry, or a value a later version adds:
  // none of them may leave the reader without a screen.
  assertEquals(startModeOf(""), "stella");
  assertEquals(startModeOf("STELLA"), "stella");
  assertEquals(startModeOf("stella-mode"), "stella");
});
