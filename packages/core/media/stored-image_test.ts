/**
 * What a transcript keeps of an image: a bounded copy.
 *
 * These pin the answers: a picture that fits is handed back untouched (not
 * even decoded), a big one loses its excess pixels with the aspect ratio
 * kept, an opaque one that still weighs too much becomes a JPEG, and a
 * transparent one never does.
 */

import { loadImage } from "@napi-rs/canvas";
import { assert, assertEquals } from "@std/assert";
import { MINI_PNG, noisyPng } from "../test-utils.ts";
import {
  prepareStoredImage,
  STORED_IMAGE_BYTES,
  STORED_IMAGE_EDGE,
} from "./stored-image.ts";

async function sizeOf(
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> {
  const image = await loadImage(bytes);
  return { width: image.width, height: image.height };
}

Deno.test("stored image: one inside the budget is returned as it is", async () => {
  const stored = await prepareStoredImage(MINI_PNG, "image/png");
  assert(!stored.changed);
  assertEquals(stored.bytes, MINI_PNG);
  assertEquals(stored.mimeType, "image/png");
  // Not decoded, so no size is claimed.
  assertEquals(stored.size, undefined);
});

Deno.test("stored image: a type this module cannot decode is untouched", async () => {
  const svg = new TextEncoder().encode("<svg></svg>");
  const stored = await prepareStoredImage(svg, "image/svg+xml");
  assert(!stored.changed);
  assertEquals(stored.bytes, svg);
});

Deno.test("stored image: bytes no decoder reads are kept, not refused", async () => {
  const garbage = new Uint8Array(STORED_IMAGE_BYTES + 1).fill(0xff);
  const stored = await prepareStoredImage(garbage, "image/png");
  assert(!stored.changed);
  assertEquals(stored.bytes.byteLength, garbage.byteLength);
});

Deno.test("stored image: a big picture loses its excess pixels", async () => {
  const source = await noisyPng(2000, 1400);
  assert(
    source.byteLength > STORED_IMAGE_BYTES,
    `fixture must exceed the budget (got ${source.byteLength})`,
  );
  const stored = await prepareStoredImage(source, "image/png");
  assert(stored.changed);
  assertEquals(stored.downscaledFrom, { width: 2000, height: 1400 });
  // 1568 is the first attempt; noise does not fit the byte budget there, so
  // the loop may take it below. Never above.
  assert(stored.size!.width <= STORED_IMAGE_EDGE);
  assert(stored.size!.height <= STORED_IMAGE_EDGE);
  // One factor on both axes: a coordinate read off the copy stays convertible
  // with a single number (see computer/tools.ts, vm/tools.ts).
  assert(
    Math.abs(stored.size!.width / stored.size!.height - 2000 / 1400) < 0.01,
    `aspect ratio: ${stored.size!.width}x${stored.size!.height}`,
  );
  assert(stored.bytes.byteLength <= STORED_IMAGE_BYTES);
  assertEquals(await sizeOf(stored.bytes), stored.size);
});

Deno.test("stored image: an opaque picture over budget becomes a JPEG", async () => {
  const source = await noisyPng(800, 600);
  assert(
    source.byteLength > STORED_IMAGE_BYTES,
    `fixture must exceed the budget (got ${source.byteLength})`,
  );
  const stored = await prepareStoredImage(source, "image/png");
  assert(stored.changed);
  assertEquals(stored.mimeType, "image/jpeg");
  // Nothing to rescale: it was already inside the edge, so only the bytes
  // were the problem. The size is reported, a downscale is not.
  assertEquals(stored.downscaledFrom, undefined);
  assertEquals(stored.size, { width: 800, height: 600 });
  assertEquals(stored.bytes[0], 0xff);
  assertEquals(stored.bytes[1], 0xd8);
});

Deno.test("stored image: a transparent picture never becomes a JPEG", async () => {
  const source = await noisyPng(1200, 900, 128);
  assert(
    source.byteLength > STORED_IMAGE_BYTES,
    `fixture must exceed the budget (got ${source.byteLength})`,
  );
  const stored = await prepareStoredImage(source, "image/png");
  assert(stored.changed);
  assertEquals(stored.mimeType, "image/png");
  assertEquals(stored.bytes[0], 0x89);
  assert(stored.bytes.byteLength < source.byteLength);
});
