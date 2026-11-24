import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  chooseSelectAlign,
  chooseSelectSide,
  SELECT_GAP,
} from "./useSelectPlacement.ts";

/**
 * Where a `Select` list opens is arithmetic over three numbers, which is why
 * it is pinned here: the bug it replaced (the thinking control of the agent
 * edit dialog opened downward into the dialog's own edge and was cut
 * mid-row) was a caller's assumption about room, not a drawing mistake.
 *
 * The clip is the box that cuts the list — a dialog, a settings body, the
 * window — not necessarily the window.
 */

/** A dialog 600px tall whose content sits between 100 and 620. */
const dialog = { top: 100, bottom: 620 };

test("chooseSelectSide: room below keeps the preferred side", () => {
  // A trigger in the middle of a dialog: the list opens where asked.
  const placement = chooseSelectSide(
    { top: 250, bottom: 280 },
    dialog,
    180,
    "below",
  );
  assertEquals(placement, { side: "below", maxHeight: null });
});

test("chooseSelectSide: a short room below opens the list above", () => {
  // The reported case: the control sits near the dialog's bottom edge, and
  // the list would be cut there.
  const placement = chooseSelectSide(
    { top: 560, bottom: 590 },
    dialog,
    190,
    "below",
  );
  assertEquals(placement, { side: "above", maxHeight: null });
});

test("chooseSelectSide: the preferred side stays when neither holds it", () => {
  // Neither side has room for the whole list: it stays where the caller asked
  // and is capped instead (a scrollable list, never a cut one).
  const clip = { top: 100, bottom: 280 };
  const placement = chooseSelectSide(
    { top: 170, bottom: 200 },
    clip,
    180,
    "below",
  );
  assertEquals(placement, { side: "below", maxHeight: 76 });
});

test("chooseSelectSide: the cap is the room on the chosen side", () => {
  const clip = { top: 100, bottom: 300 };
  // 160 for the list below, 62 above: the list goes below and keeps the
  // larger room, capped to it.
  const placement = chooseSelectSide(
    { top: 136, bottom: 166 },
    clip,
    300,
    "above",
  );
  assertEquals(placement, { side: "below", maxHeight: 300 - 166 - SELECT_GAP });
});

test("chooseSelectSide: a list that fits is never capped", () => {
  const placement = chooseSelectSide(
    { top: 560, bottom: 590 },
    dialog,
    26,
    "below",
  );
  assertEquals(placement, { side: "below", maxHeight: null });
});

test("chooseSelectSide: the room is the clip's, not the window's", () => {
  // A trigger inside a short dialog, with a world of window below it: the
  // list follows the dialog's edge (the box that clips it), not the window's.
  const placement = chooseSelectSide(
    { top: 480, bottom: 510 },
    dialog,
    190,
    "below",
  );
  assertEquals(placement.side, "above");
});

/** A 640px-wide settings dialog between x=80 and x=720. */
const frame = { left: 80, right: 720 };

test("chooseSelectAlign: a list with room to the right stays left-aligned", () => {
  // The control sits mid-row: its 320px list ends 200px before the dialog.
  const placement = chooseSelectAlign({ left: 200, right: 360 }, frame, 320);
  assertEquals(placement, { align: "start", maxWidth: null });
});

test("chooseSelectAlign: a row's trailing control flips the list to the left", () => {
  // The reported case: a select at the right edge of the settings row. A
  // left-aligned 320px list would end 240px past the dialog and make the
  // whole pane scroll sideways.
  const placement = chooseSelectAlign({ left: 560, right: 700 }, frame, 320);
  assertEquals(placement, { align: "end", maxWidth: null });
});

test("chooseSelectAlign: neither side fits caps the width", () => {
  // A narrow clip: the list keeps the larger side and scrolls inside itself.
  const placement = chooseSelectAlign(
    { left: 100, right: 300 },
    { left: 80, right: 360 },
    320,
  );
  assertEquals(placement, { align: "start", maxWidth: 260 });
});

test("chooseSelectAlign: the end side gets the cap when it has more room", () => {
  const placement = chooseSelectAlign(
    { left: 200, right: 340 },
    { left: 80, right: 360 },
    320,
  );
  assertEquals(placement, { align: "end", maxWidth: 260 });
});
