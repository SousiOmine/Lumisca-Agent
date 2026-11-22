import { test } from "bun:test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type ActionPrimitives,
  DRAG_MS,
  interpolatePoint,
  MOVE_MS,
  NAMED_KEY_IDS,
  namedKeyId,
  parseKeyChord,
  performAction,
  splitTypeText,
} from "./motion.ts";

// --- interpolation ----------------------------------------------------------

test("interpolatePoint walks the straight line and hits both ends", () => {
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

test("interpolatePoint rounds to whole pixels", () => {
  assertEquals(interpolatePoint({ x: 0, y: 0 }, { x: 3, y: 3 }, 1 / 3), {
    x: 1,
    y: 1,
  });
});

// --- typing -----------------------------------------------------------------

test("splitTypeText turns newlines into Enter presses", () => {
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

test("parseKeyChord splits modifiers from the key", () => {
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

test("parseKeyChord keeps a lone character whole", () => {
  // "+" is the separator, so it is only expressible as a lone character.
  assertEquals(parseKeyChord("+"), { modifiers: [], key: "+" });
  assertEquals(parseKeyChord("A"), { modifiers: [], key: "A" });
  assertEquals(parseKeyChord("あ"), { modifiers: [], key: "あ" });
});

test("parseKeyChord refuses chords it cannot honour", () => {
  assertThrows(() => parseKeyChord(""), Error, "must not be empty");
  assertThrows(() => parseKeyChord("ctrl+"), Error, "has modifiers but no key");
  assertThrows(() => parseKeyChord("a+b"), Error, "more than one key");
});

// --- timings ----------------------------------------------------------------

test("the movement timings stay human-scale and ordered", () => {
  // The values are the contract the tool description and the skill state:
  // ~0.1s for a move, longer for a drag path.
  assertEquals(MOVE_MS, 100);
  assertEquals(DRAG_MS, 300);
  assert(DRAG_MS > MOVE_MS);
});

// --- named keys -------------------------------------------------------------

test("NAMED_KEY_IDS is the one list of names a chord may spell", () => {
  // The set is the syntax, not a platform's convenience: both hosts read it,
  // and each only owns the value a name maps to.
  assertEquals(namedKeyId("Enter"), "enter");
  assertEquals(namedKeyId("PGUP"), "pgup");
  assertEquals(namedKeyId("f24"), "f24");
  // A name outside the table is left to the host (a single character, or a
  // name neither platform knows).
  assertEquals(namedKeyId("a"), undefined);
  assertEquals(namedKeyId("nope"), undefined);
  // The table has no duplicate that would make one name shadow another.
  assertEquals(new Set(NAMED_KEY_IDS).size, NAMED_KEY_IDS.length);
});

// --- the shared action procedure -------------------------------------------

/** Primitives that record what they were asked, so the ORDER of the steps is
 * what these tests read. */
function recorderPrimitives(): ActionPrimitives & { calls: string[] } {
  const calls: string[] = [];
  const window = {
    id: "0x00000001",
    title: "Editor",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    focused: true,
    visible: true,
    minimized: false,
  };
  return {
    calls,
    movePointer: (x, y) => {
      calls.push(`move ${x},${y}`);
      return Promise.resolve(3);
    },
    button: (button, pressed) => {
      calls.push(`${button} ${pressed ? "down" : "up"}`);
      return Promise.resolve();
    },
    wheel: (deltaX, deltaY) => {
      calls.push(`wheel ${deltaX},${deltaY}`);
      return Promise.resolve();
    },
    typeText: (text) => {
      calls.push(`type ${text}`);
      return Promise.resolve();
    },
    key: (chord) => {
      calls.push(`key ${chord}`);
      return Promise.resolve();
    },
    focusWindow: (id) => {
      calls.push(`focus ${id}`);
      return Promise.resolve(window);
    },
    cursor: () => ({ x: 1, y: 2 }),
    foregroundWindow: () => window,
  };
}

test("performAction holds the button across a drag path", async () => {
  const primitives = recorderPrimitives();
  const result = await performAction(primitives, {
    kind: "drag",
    from: { x: 1, y: 1 },
    to: { x: 9, y: 9 },
    button: "left",
  });
  assertEquals(primitives.calls, [
    "move 1,1",
    "left down",
    "move 9,9",
    "left up",
  ]);
  // Both movements count: the approach is part of the path the pointer took.
  assertEquals(result.steps, 6);
  assertEquals(result.cursor, { x: 1, y: 2 });
});

test("performAction clicks as many times as asked, settling in between", async () => {
  const primitives = recorderPrimitives();
  await performAction(primitives, {
    kind: "click",
    x: 4,
    y: 5,
    button: "right",
    count: 2,
  });
  assertEquals(primitives.calls, [
    "move 4,5",
    "right down",
    "right up",
    "right down",
    "right up",
  ]);
});

test("performAction scrolls only the axes that carry a delta", async () => {
  const primitives = recorderPrimitives();
  await performAction(primitives, {
    kind: "scroll",
    x: 2,
    y: 3,
    deltaX: 0,
    deltaY: -1,
  });
  assertEquals(primitives.calls, ["move 2,3", "wheel 0,-1"]);
});

test("a keyboard action reports the window it went to", async () => {
  const primitives = recorderPrimitives();
  const typed = await performAction(primitives, { kind: "type", text: "hi" });
  const pressed = await performAction(primitives, {
    kind: "key",
    key: "ctrl+s",
  });
  assertEquals(primitives.calls, ["type hi", "key ctrl+s"]);
  assertEquals(typed.window?.title, "Editor");
  assertEquals(pressed.window?.title, "Editor");
  assertEquals(typed.steps, 0);
});

test("focus_window and wait go through the primitives, not around them", async () => {
  const primitives = recorderPrimitives();
  const focused = await performAction(primitives, {
    kind: "focus_window",
    window: "0x00000001",
  });
  const waited = await performAction(primitives, {
    kind: "wait",
    durationMs: 1,
  });
  assertEquals(primitives.calls, ["focus 0x00000001"]);
  assertEquals(focused.window?.title, "Editor");
  assertEquals(waited.steps, 0);
});
