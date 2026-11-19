/**
 * Which mode a bare `/` starts in.
 *
 * The desktop shell, an installed PWA and a plain bookmark all open `/`, and
 * that address has to answer a mode on its own: a first launch starts in the
 * main mode (Lumisca) rather than at any choice screen, and a client that has
 * chosen before starts where it left off — unless the mode it left off in is
 * code mode and this installation has switched code mode off.
 */
import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { MAIN_MODE, startModeOf } from "./useAppMode.ts";

test("startModeOf: a client that never chose starts in the main mode", () => {
  assertEquals(MAIN_MODE, "stella");
  assertEquals(startModeOf(null, true), "stella");
  assertEquals(startModeOf(null, false), "stella");
});

test("startModeOf: a stored mode is the answer when it is offered", () => {
  assertEquals(startModeOf("stella", true), "stella");
  assertEquals(startModeOf("code", true), "code");
});

test("startModeOf: a stored code mode is not offered while the switch is off", () => {
  // The mode is an experimental switch (settings → 実験的機能), off by
  // default: a client that stored code mode before it was switched off must
  // start where it can work, not on a screen the app replaces at once.
  assertEquals(startModeOf("code", false), "stella");
  assertEquals(startModeOf("stella", false), "stella");
});

test("startModeOf: an unknown value is the same as no choice", () => {
  // An older spelling, a hand-edited entry, or a value a later version adds:
  // none of them may leave the reader without a screen.
  assertEquals(startModeOf("", true), "stella");
  assertEquals(startModeOf("STELLA", true), "stella");
  assertEquals(startModeOf("stella-mode", true), "stella");
});
