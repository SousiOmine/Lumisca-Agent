import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  type Attachments,
  canAttach,
  imageSlotAvailable,
  useAttachments,
} from "./useAttachments.ts";

test("canAttach: a picture rides in the message, so every mode takes one", () => {
  assertEquals(canAttach({ type: "image/png" }, false), true);
  assertEquals(canAttach({ type: "image/jpeg" }, true), true);
});

test("canAttach: any other file needs a machine to be written into", () => {
  assertEquals(canAttach({ type: "text/plain" }, true), true);
  assertEquals(canAttach({ type: "application/pdf" }, true), true);
  // code mode: the tools work on the user's own folders, so there is nowhere
  // for the upload to go (the prompt route refuses upload ids outside stella).
  assertEquals(canAttach({ type: "text/plain" }, false), false);
  // The OS could not name the type: not a picture, so it needs the machine.
  assertEquals(canAttach({ type: "" }, false), false);
});

test("imageSlotAvailable: a read in flight holds its place", () => {
  assertEquals(imageSlotAvailable(0, 0), true);
  assertEquals(imageSlotAvailable(7, 0), true);
  // The eighth picture's bytes are still being read: a ninth would pass the
  // committed-count check and arrive after it, which is the race that let a
  // prompt carry nine images to a server that accepts eight.
  assertEquals(imageSlotAvailable(7, 1), false);
  assertEquals(imageSlotAvailable(8, 0), false);
});

test("addAll: a burst of nine pictures starts only eight reads", async () => {
  // Bun has no FileReader; the read itself is not what this test checks, only
  // how many reads a burst starts. The ninth picture must be refused before
  // its bytes are read, because the first eight have not landed yet.
  let reads = 0;
  class FakeReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: File): void {
      reads += 1;
      this.result = `data:${file.type};base64,AAAA`;
      queueMicrotask(() => this.onload?.());
    }
  }
  const original = globalThis.FileReader;
  globalThis.FileReader = FakeReader as unknown as typeof FileReader;
  try {
    let api: Attachments | undefined;
    function Probe(): null {
      api = useAttachments({
        images: [],
        files: [],
        onImagesChange: () => {},
        t: (key) => key,
      });
      return null;
    }
    renderToString(h(Probe, {}));
    const pictures = Array.from({ length: 9 }, (_, index) => {
      return new File([new Uint8Array([1])], `p${index}.png`, {
        type: "image/png",
      });
    });
    api?.addAll(pictures);
    assertEquals(reads, 8);
  } finally {
    globalThis.FileReader = original;
  }
});
