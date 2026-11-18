/**
 * The press rule of the window's caption strip, without a browser.
 *
 * The regression this pins down is a window whose top edge could be dragged
 * but not double-clicked: the first press starts the OS's move loop, whose
 * capture swallows the release, so waiting for `dblclick` waits forever. The
 * rule is that the second press carries the decision.
 */
import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { captionPress } from "./titlebar-press.ts";

test("captionPress: the first press drags, the second maximizes", () => {
  assertEquals(captionPress(1), "drag");
  assertEquals(captionPress(2), "toggle-maximize");
});

test("captionPress: a press outside the double click does nothing", () => {
  // A third press is still the same caption sequence; acting on it would
  // toggle the window back. Zero never reaches a real mousedown, but the
  // answer must not be a drag by accident.
  assertEquals(captionPress(3), "none");
  assertEquals(captionPress(0), "none");
});
