import { assertEquals } from "@std/assert";
import {
  carriesFiles,
  consumeFileDrag,
  type FileDragEvent,
  installFileDropGuard,
} from "./drop-guard.ts";

/** A drag event the guard can read, plus the one thing it does to it. */
function drag(types: string[] | undefined): FileDragEvent & {
  cancelled: boolean;
} {
  const event = {
    dataTransfer: types === undefined ? null : { types },
    cancelled: false,
    preventDefault() {
      event.cancelled = true;
    },
  };
  return event;
}

Deno.test("carriesFiles: only a drag with files is the page's to consume", () => {
  assertEquals(carriesFiles(["Files"]), true);
  assertEquals(carriesFiles(["text/plain"]), false);
  assertEquals(carriesFiles([]), false);
  assertEquals(carriesFiles(undefined), false);
});

Deno.test("consumeFileDrag: a file drag is cancelled, anything else is left alone", () => {
  const file = drag(["Files"]);
  consumeFileDrag(file);
  assertEquals(file.cancelled, true);

  // Dragging text into a field belongs to the browser.
  const text = drag(["text/plain"]);
  consumeFileDrag(text);
  assertEquals(text.cancelled, false);

  // A drag with no data transfer at all (some synthetic events) says nothing
  // about files.
  const none = drag(undefined);
  consumeFileDrag(none);
  assertEquals(none.cancelled, false);
});

Deno.test("installFileDropGuard: both the drag over the page and the drop are refused", () => {
  const listeners = new Map<string, (event: FileDragEvent) => void>();
  const target = {
    addEventListener(type: string, listener: (event: FileDragEvent) => void) {
      listeners.set(type, listener);
    },
  } as unknown as Document;

  installFileDropGuard(target);

  // Dragover is what decides whether a drop is allowed at all: leaving it
  // alone over the page would refuse the drop without ever refusing the
  // navigation.
  assertEquals([...listeners.keys()].sort(), ["dragover", "drop"]);
  for (const listener of listeners.values()) {
    const file = drag(["Files"]);
    listener(file);
    assertEquals(file.cancelled, true);

    const text = drag(["text/plain"]);
    listener(text);
    assertEquals(text.cancelled, false);
  }
});
