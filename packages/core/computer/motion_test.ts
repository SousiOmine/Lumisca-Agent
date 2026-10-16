import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  DRAG_MS,
  interpolatePoint,
  MOVE_MS,
  parseKeyChord,
  splitTypeText,
} from "./motion.ts";

// --- interpolation ----------------------------------------------------------

Deno.test("interpolatePoint walks the straight line and hits both ends", () => {
  const from = { x: 10, y: 20 };
  const to = { x: 110, y: 70 };
  assertEquals(interpolatePoint(from, to, 0), { x: 10, y: 20 });
  assertEquals(interpolatePoint(from, to, 1), { x: 110, y: 70 });
  assertEquals(interpolatePoint(from, to, 0.5), { x: 60, y: 45 });
  // Out-of-range ratios clamp: a late timer tick must not overshoot the
  // target (the last step is the one that decides where a click lands).
  assertEquals(interpolatePoint(from, to, 1.5), { x: 110, y: 70 });
  assertEquals(interpolatePoint(from, to, -1), { x: 10, y: 20 });
});

Deno.test("interpolatePoint rounds to whole pixels", () => {
  assertEquals(
    interpolatePoint({ x: 0, y: 0 }, { x: 3, y: 3 }, 1 / 3),
    { x: 1, y: 1 },
  );
});

// --- typing -----------------------------------------------------------------

Deno.test("splitTypeText turns newlines into Enter presses", () => {
  assertEquals(splitTypeText("a\nb"), [
    { kind: "text", value: "a" },
    { kind: "enter" },
    { kind: "text", value: "b" },
  ]);
  // CRLF and a lone CR are the same newline (a CR/LF character is dropped by
  // most controls, so it must become a real Enter).
  assertEquals(splitTypeText("a\r\nb\rc"), [
    { kind: "text", value: "a" },
    { kind: "enter" },
    { kind: "text", value: "b" },
    { kind: "enter" },
    { kind: "text", value: "c" },
  ]);
  // Empty lines become consecutive Enters.
  assertEquals(splitTypeText("a\n\nb"), [
    { kind: "text", value: "a" },
    { kind: "enter" },
    { kind: "enter" },
    { kind: "text", value: "b" },
  ]);
  // A trailing newline still presses Enter (the caret ends on a fresh line).
  assertEquals(splitTypeText("trailing\n"), [
    { kind: "text", value: "trailing" },
    { kind: "enter" },
  ]);
  assertEquals(splitTypeText("plain"), [{ kind: "text", value: "plain" }]);
  assertEquals(splitTypeText(""), []);
  assertEquals(splitTypeText("\n"), [{ kind: "enter" }]);
});

// --- key chords (the syntax every host accepts) -----------------------------

Deno.test("parseKeyChord splits modifiers from the key", () => {
  assertEquals(parseKeyChord("enter"), { modifiers: [], key: "enter" });
  assertEquals(parseKeyChord("Enter"), { modifiers: [], key: "Enter" });
  assertEquals(parseKeyChord("ctrl+shift+s"), {
    modifiers: ["ctrl", "shift"],
    key: "s",
  });
  // The spellings of a modifier are aliases of one name, and naming it twice
  // presses it once.
  assertEquals(parseKeyChord("win+left"), {
    modifiers: ["super"],
    key: "left",
  });
  assertEquals(parseKeyChord("meta+ctrl+ctrl+a"), {
    modifiers: ["super", "ctrl"],
    key: "a",
  });
  // Spaces around the parts are padding, not key names.
  assertEquals(parseKeyChord(" ctrl + alt + delete "), {
    modifiers: ["ctrl", "alt"],
    key: "delete",
  });
});

Deno.test("parseKeyChord keeps a lone character whole", () => {
  // "+" is the separator, so it is only expressible as a lone character.
  assertEquals(parseKeyChord("+"), { modifiers: [], key: "+" });
  assertEquals(parseKeyChord("A"), { modifiers: [], key: "A" });
  assertEquals(parseKeyChord("あ"), { modifiers: [], key: "あ" });
});

Deno.test("parseKeyChord refuses chords it cannot honour", () => {
  assertThrows(() => parseKeyChord(""), Error, "must not be empty");
  assertThrows(() => parseKeyChord("ctrl+"), Error, "has modifiers but no key");
  assertThrows(() => parseKeyChord("a+b"), Error, "more than one key");
});

// --- timings ----------------------------------------------------------------

Deno.test("the movement timings stay human-scale and ordered", () => {
  // The values are the contract the tool description and the skill state:
  // ~0.1s for a move, longer for a drag path.
  assertEquals(MOVE_MS, 100);
  assertEquals(DRAG_MS, 300);
  assert(DRAG_MS > MOVE_MS);
});
