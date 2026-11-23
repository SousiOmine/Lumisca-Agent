import { test } from "bun:test";
import * as fsSync from "node:fs";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { paneEntranceOffset } from "./StellaPane.tsx";

test("paneEntranceOffset: the gap belongs to the space the pane borrows", () => {
  // The pane sits after the row's gap. Pulling it left by its own width alone
  // would leave the conversation 10px narrower on the first frame, which is
  // the snap this animation exists to remove.
  assertEquals(paneEntranceOffset(431.1875, 10), 441.1875);
  assertEquals(paneEntranceOffset(320, 0), 320);
  // `column-gap: normal` parses to NaN. The row then has no gap to count.
  assertEquals(paneEntranceOffset(320, Number.NaN), 320);
});

test("StellaPane: the pane's margin carries the conversation's width", () => {
  // The noVNC picture derives its scale from the pane's box, so the box must
  // not change size while the pane arrives. The conversation's right edge is
  // what moves: the pane starts pulled left by its own width and the gap, and
  // the margin walks back to zero. Pinned here because the animation is a DOM
  // effect that a static render cannot run.
  const source = fsSync.readFileSync(
    new URL("./StellaPane.tsx", import.meta.url),
    "utf8",
  );
  assertStringIncludes(source, "paneOffsetOf(element)");
  assertStringIncludes(source, "marginLeft:");
  assertStringIncludes(source, "element.style.marginLeft = `-${offset}px`");
  // The compact width puts the pane under the conversation or over the whole
  // screen; a negative margin there would move it sideways.
  assertStringIncludes(source, "const offset = compact ? 0");
});
