import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildKeyChordInputs,
  buildKeyInput,
  buildMouseInput,
  buildUnicodeInputs,
  concatInputs,
  createWindowsComputerHost,
  DRAG_MS,
  formatWindowId,
  inputSize,
  interpolatePoint,
  MAX_WINDOW_TITLE_CHARS,
  MOVE_MS,
  normalizeAbsolute,
  parseWindowId,
  pointerSizeFor,
  resolveKeyChord,
  splitTypeText,
} from "./windows.ts";

/** The layout lookup a test stands in for VkKeyScanW: the virtual key of a
 * character is its upper-case ASCII code (VK for "s" is 0x53), which is
 * what the real API reports. */
const asciiScan = (char: string): number | undefined => {
  const code = char.toUpperCase().charCodeAt(0);
  return code < 128 ? code : undefined;
};

/** A probe host, closed immediately: the `ignore` conditions of the live
 * tests need to know whether this machine has a usable host before any test
 * runs. Creating it here also covers the "no display / no libraries" path
 * (the result is then a reason, and the live tests are skipped). */
const probe = Deno.build.os === "windows"
  ? createWindowsComputerHost()
  : undefined;
const liveHost = probe?.available === true ? probe.host : undefined;
if (probe?.available === true) probe.host.close();

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

// --- absolute coordinate normalization --------------------------------------

Deno.test("normalizeAbsolute maps the virtual desktop onto 0..65535", () => {
  // A desktop starting at -2560 (a monitor left of the primary) with a
  // width of 7680: the far edges are the extremes, the primary's origin is
  // the ratio between them.
  assertEquals(normalizeAbsolute(-2560, -2560, 7680), 0);
  assertEquals(normalizeAbsolute(5119, -2560, 7680), 65535);
  assertEquals(normalizeAbsolute(0, -2560, 7680), 21848);
  // Values outside the desktop clamp instead of wrapping around.
  assertEquals(normalizeAbsolute(-9999, -2560, 7680), 0);
  assertEquals(normalizeAbsolute(9999, -2560, 7680), 65535);
});

Deno.test("normalizeAbsolute handles a degenerate extent", () => {
  assertEquals(normalizeAbsolute(5, 5, 1), 0);
});

// --- INPUT structure packing ------------------------------------------------

Deno.test("inputSize follows the pointer width", () => {
  assertEquals(inputSize(8), 40);
  assertEquals(inputSize(4), 28);
  assertEquals(pointerSizeFor("x86_64"), 8);
  assertEquals(pointerSizeFor("aarch64"), 8);
  assertEquals(pointerSizeFor("x86"), 4);
});

Deno.test("buildMouseInput lays the fields out where SendInput expects them", () => {
  for (const pointerSize of [8, 4]) {
    const buffer = buildMouseInput(7, 9, 0x8001, 120, pointerSize);
    assertEquals(buffer.length, inputSize(pointerSize));
    const view = new DataView(buffer.buffer);
    const base = pointerSize === 8 ? 8 : 4;
    assertEquals(view.getUint32(0, true), 0, "type: INPUT_MOUSE");
    assertEquals(view.getInt32(base, true), 7, "dx");
    assertEquals(view.getInt32(base + 4, true), 9, "dy");
    assertEquals(view.getUint32(base + 8, true), 120, "mouseData");
    assertEquals(view.getUint32(base + 12, true), 0x8001, "dwFlags");
    assertEquals(view.getUint32(base + 16, true), 0, "time");
  }
});

Deno.test("buildKeyInput lays the fields out where SendInput expects them", () => {
  for (const pointerSize of [8, 4]) {
    const buffer = buildKeyInput(0x41, 0x3042, 0x0004, pointerSize);
    assertEquals(buffer.length, inputSize(pointerSize));
    const view = new DataView(buffer.buffer);
    const base = pointerSize === 8 ? 8 : 4;
    assertEquals(view.getUint32(0, true), 1, "type: INPUT_KEYBOARD");
    assertEquals(view.getUint16(base, true), 0x41, "wVk");
    assertEquals(view.getUint16(base + 2, true), 0x3042, "wScan");
    assertEquals(view.getUint32(base + 4, true), 0x0004, "dwFlags");
    assertEquals(view.getUint32(base + 8, true), 0, "time");
  }
});

Deno.test("buildUnicodeInputs emits a down and an up per code unit", () => {
  const buffer = buildUnicodeInputs([0x41, 0x3042], 8);
  assertEquals(buffer.length, 4 * inputSize(8));
  const view = new DataView(buffer.buffer);
  const flags = (index: number) => view.getUint32(index * 40 + 12, true);
  const scan = (index: number) => view.getUint16(index * 40 + 10, true);
  // 0x0004 = KEYEVENTF_UNICODE, 0x0006 = unicode + KEYUP.
  assertEquals([flags(0), flags(1)], [0x0004, 0x0006]);
  assertEquals([scan(0), scan(1)], [0x41, 0x41]);
  assertEquals([scan(2), scan(3)], [0x3042, 0x3042]);
});

Deno.test("buildKeyChordInputs holds modifiers around the key", () => {
  const buffer = buildKeyChordInputs(0x53, [0x11, 0x10], 8);
  // Two modifiers down, the key down and up, then the modifiers up again.
  assertEquals(buffer.length, 6 * inputSize(8));
  const view = new DataView(buffer.buffer);
  const entry = (index: number) => ({
    vk: view.getUint16(index * 40 + 8, true),
    flags: view.getUint32(index * 40 + 12, true),
  });
  assertEquals(entry(0), { vk: 0x11, flags: 0 }, "ctrl down");
  assertEquals(entry(1), { vk: 0x10, flags: 0 }, "shift down");
  assertEquals(entry(2), { vk: 0x53, flags: 0 }, "key down");
  assertEquals(entry(3), { vk: 0x53, flags: 0x0002 }, "key up");
  assertEquals(entry(4), { vk: 0x10, flags: 0x0002 }, "shift up");
  assertEquals(entry(5), { vk: 0x11, flags: 0x0002 }, "ctrl up");
});

Deno.test("concatInputs joins the structures in order", () => {
  const joined = concatInputs([
    new Uint8Array([1, 2]),
    new Uint8Array([3]),
    new Uint8Array([4, 5]),
  ]);
  assertEquals([...joined], [1, 2, 3, 4, 5]);
});

// --- key chords -------------------------------------------------------------

Deno.test("resolveKeyChord understands named keys and modifiers", () => {
  assertEquals(resolveKeyChord("enter", asciiScan), {
    vk: 0x0d,
    modifiers: [],
  });
  assertEquals(resolveKeyChord("Enter", asciiScan), {
    vk: 0x0d,
    modifiers: [],
  });
  assertEquals(resolveKeyChord("f5", asciiScan), { vk: 0x74, modifiers: [] });
  assertEquals(resolveKeyChord("pageup", asciiScan), {
    vk: 0x21,
    modifiers: [],
  });
  assertEquals(resolveKeyChord("ctrl+shift+s", asciiScan), {
    vk: 0x53,
    modifiers: [0x11, 0x10],
  });
  assertEquals(resolveKeyChord("win+left", asciiScan), {
    vk: 0x25,
    modifiers: [0x5b],
  });
});

Deno.test("resolveKeyChord resolves single characters through the layout", () => {
  // A character that needs Shift on this layout has it pressed implicitly:
  // "press the key that produces this character".
  assertEquals(
    resolveKeyChord("A", (char) => {
      return char === "A" ? 0x41 | (1 << 8) : 0x41;
    }),
    { vk: 0x41, modifiers: [0x10] },
  );
  // "+" is the chord separator, so it is only expressible as a lone
  // character — which must not be split.
  assertEquals(resolveKeyChord("+", () => 0xbb | (1 << 8)), {
    vk: 0xbb,
    modifiers: [0x10],
  });
});

Deno.test("resolveKeyChord refuses chords it cannot honour", () => {
  assertThrows(
    () => resolveKeyChord("", asciiScan),
    Error,
    "must not be empty",
  );
  assertThrows(
    () => resolveKeyChord("ctrl+", asciiScan),
    Error,
    "has modifiers but no key",
  );
  assertThrows(
    () => resolveKeyChord("a+b", asciiScan),
    Error,
    "more than one key",
  );
  assertThrows(
    () => resolveKeyChord("nope", asciiScan),
    Error,
    "unknown key",
  );
  assertThrows(
    () => resolveKeyChord("あ", asciiScan),
    Error,
    "no key produces",
  );
});

Deno.test("splitTypeText turns newlines into Enter presses", () => {
  assertEquals(splitTypeText("a\nb"), [
    { kind: "text", value: "a" },
    { kind: "enter" },
    { kind: "text", value: "b" },
  ]);
  // CRLF and a lone CR are the same newline (a Unicode CR/LF character is
  // dropped by the controls, so it must become a real Enter).
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

// --- window ids -------------------------------------------------------------

Deno.test("window ids round-trip through the hex form", () => {
  assertEquals(formatWindowId(parseWindowId("0x000A0B2C")), "0x000A0B2C");
  assertEquals(formatWindowId(parseWindowId("0xa0b2c")), "0x000A0B2C");
});

Deno.test("parseWindowId refuses anything but a hex handle", () => {
  for (const bad of ["", "1234", "0x", "0xzz", "0x 12"]) {
    assertThrows(() => parseWindowId(bad), Error, "must look like");
  }
});

// --- the live host (Windows with a display only) ----------------------------

Deno.test("the Windows host describes itself and lists its displays", {
  ignore: liveHost === undefined,
}, () => {
  const host = createWindowsComputerHost();
  assert(host.available, "the probe found a host, so creating one must too");
  try {
    const displays = host.host.displays();
    assert(displays.length > 0, "at least one display");
    assertEquals(
      displays.map((display) => display.index),
      displays.map((_, index) => index),
      "indices follow the reported order",
    );
    assertEquals(
      displays.filter((display) => display.primary).length,
      1,
      "exactly one primary display",
    );
    for (const display of displays) {
      assert(display.bounds.width > 0 && display.bounds.height > 0);
    }
    // Left to right, which is the order the indices promise.
    const xs = displays.map((display) => display.bounds.x);
    assertEquals([...xs].sort((a, b) => a - b), xs);
    assert(host.host.describe().includes("Windows"));
    host.host.close();
  } finally {
    host.host.close();
  }
});

Deno.test("the Windows host captures the requested region at 1:1", {
  ignore: liveHost === undefined,
}, async () => {
  const host = createWindowsComputerHost();
  assert(host.available);
  try {
    const primary = host.host.displays().find((display) => display.primary)!;
    const region = {
      x: primary.bounds.x + 4,
      y: primary.bounds.y + 4,
      width: 32,
      height: 24,
    };
    const capture = await host.host.capture(region);
    assertEquals(capture.screen, region);
    assertEquals([capture.width, capture.height], [32, 24]);
    assertEquals(capture.pixels.length, 32 * 24 * 4);
  } finally {
    host.host.close();
  }
});

Deno.test("the Windows host reports windows with usable ids", {
  ignore: liveHost === undefined,
}, () => {
  const host = createWindowsComputerHost();
  assert(host.available);
  try {
    const windows = host.host.windows();
    assert(windows.length > 0, "a desktop session has windows");
    for (const window of windows) {
      // Every reported id must be accepted back by the focus action.
      assertEquals(formatWindowId(parseWindowId(window.id)), window.id);
      assert(window.title.length > 0, "untitled windows are not reported");
      assert(window.title.length <= MAX_WINDOW_TITLE_CHARS);
    }
    assertEquals(
      windows.filter((window) => window.focused).length <= 1,
      true,
      "at most one window holds the focus",
    );
  } finally {
    host.host.close();
  }
});

Deno.test("closing the host twice is safe", {
  ignore: liveHost === undefined,
}, () => {
  const host = createWindowsComputerHost();
  assert(host.available);
  host.host.close();
  host.host.close();
});

// --- timings ----------------------------------------------------------------

Deno.test("the movement timings stay human-scale and ordered", () => {
  // The values are the contract the tool description and the skill state:
  // ~0.1s for a move, longer for a drag path.
  assertEquals(MOVE_MS, 100);
  assertEquals(DRAG_MS, 300);
  assert(DRAG_MS > MOVE_MS);
});
