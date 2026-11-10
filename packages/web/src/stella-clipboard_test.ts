import { assertEquals } from "@std/assert";
import {
  normalizeClipboardText,
  type PasteChordEvent,
  pasteChordOf,
} from "./stella-clipboard.ts";

function keyEvent(overrides: Partial<PasteChordEvent> = {}): PasteChordEvent {
  return {
    key: "v",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

Deno.test("pasteChordOf: Ctrl+V and Cmd+V are the same paste", () => {
  // The machine is Linux: a Mac's Cmd+V has to arrive as Ctrl+V there, or the
  // application receives super+v and pastes nothing.
  assertEquals(pasteChordOf(keyEvent({ ctrlKey: true })), { shift: false });
  assertEquals(pasteChordOf(keyEvent({ metaKey: true })), { shift: false });
});

Deno.test("pasteChordOf: a terminal's Ctrl+Shift+V keeps its shift", () => {
  assertEquals(pasteChordOf(keyEvent({ ctrlKey: true, shiftKey: true })), {
    shift: true,
  });
});

Deno.test("pasteChordOf: everything else is left to the machine", () => {
  // A bare `v` is typing, Ctrl+C is the application's copy, and Alt+V is a
  // menu accelerator or a dead key rather than a paste.
  assertEquals(pasteChordOf(keyEvent()), null);
  assertEquals(pasteChordOf(keyEvent({ ctrlKey: true, key: "c" })), null);
  assertEquals(pasteChordOf(keyEvent({ ctrlKey: true, altKey: true })), null);
  assertEquals(pasteChordOf(keyEvent({ key: "V", shiftKey: true })), null);
});

Deno.test("normalizeClipboardText: a browser's line endings become the machine's", () => {
  assertEquals(normalizeClipboardText("a\r\nb\rc"), "a\nb\nc");
  assertEquals(normalizeClipboardText("そのまま\n二行目"), "そのまま\n二行目");
});
