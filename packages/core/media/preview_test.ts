/**
 * Downscaled previews: the small copy a conversation draws.
 *
 * The original is kept as it was (the click opens it, and the model reads
 * it); what these pin is that a big picture gets a small copy, that the copy
 * keeps its format, and that an image already small enough is left alone
 * (re-encoding it would only cost bytes).
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { assert, assertEquals } from "@std/assert";
import {
  isPreviewable,
  PREVIEW_EDGE,
  previewSize,
  renderPreview,
} from "./preview.ts";

/** A PNG of `width` x `height`, drawn with a solid colour so a decoder reads
 * real pixels. */
function makePng(width: number, height: number): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#3366cc";
  context.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

async function pngSize(
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> {
  const image = await loadImage(bytes);
  return { width: image.width, height: image.height };
}

Deno.test("previewSize: a long edge of PREVIEW_EDGE, aspect kept", () => {
  assertEquals(previewSize(4000, 3000), { width: PREVIEW_EDGE, height: 960 });
  assertEquals(previewSize(3000, 4000), { width: 960, height: PREVIEW_EDGE });
  assertEquals(previewSize(PREVIEW_EDGE, 100), {
    width: PREVIEW_EDGE,
    height: 100,
  });
});

Deno.test("previewSize: an image already small enough is unchanged", () => {
  assertEquals(previewSize(320, 200), { width: 320, height: 200 });
});

Deno.test("renderPreview: a big picture comes back smaller", async () => {
  const source = makePng(2400, 1200);
  const preview = await renderPreview(source, "image/png");
  assert(preview !== undefined, "a 2400px picture must have a preview");
  assertEquals(await pngSize(preview!), {
    width: PREVIEW_EDGE,
    height: 640,
  });
  assert(
    preview!.byteLength < source.byteLength,
    `preview ${preview!.byteLength} < source ${source.byteLength}`,
  );
});

Deno.test("renderPreview: an image within the edge produces nothing", async () => {
  // The caller serves the original: a re-encode of a small picture is bigger
  // than the picture, and identical to the eye.
  assertEquals(await renderPreview(makePng(320, 200), "image/png"), undefined);
});

Deno.test("renderPreview: an unsupported or broken source produces nothing", async () => {
  // SVG is a document, not pixels; bytes that do not decode have no
  // preview. Both fall back to the original rather than to an error.
  assertEquals(
    await renderPreview(new Uint8Array(), "image/svg+xml"),
    undefined,
  );
  assertEquals(
    await renderPreview(new Uint8Array([1, 2, 3]), "image/png"),
    undefined,
  );
  // An empty body of a type this module does decode: loadImage refuses it,
  // and the route answers with the original.
  assertEquals(await renderPreview(new Uint8Array(), "image/png"), undefined);
});

Deno.test("isPreviewable names the raster formats the route can scale", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    assertEquals(isPreviewable(type), true, type);
  }
  assertEquals(isPreviewable("image/svg+xml"), false);
  assertEquals(isPreviewable("application/pdf"), false);
});
