/**
 * Downscaled previews of images the app serves.
 *
 * A conversation fills up with screenshots: a `vm_screenshot` is 1280x800, a
 * phone photo is 4000px wide, and an agent that writes pasteboards attaches
 * several. Each one is drawn at a few hundred pixels — the bytes above that
 * are decoded, laid out and thrown away on every scroll, which is what makes a
 * long conversation feel heavy on a phone. The stored original stays exactly
 * as it was (it is what a click opens, and what the model reads); this module
 * produces the small copy the list draws.
 *
 * The result is cached beside the asset that produced it: a preview is a pure
 * function of the source bytes and {@link PREVIEW_EDGE}, so it never goes
 * stale as long as it is stored under the source's own identity.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";

/** Longest edge of a preview, in pixels.
 *
 * The list draws an image at up to ~640 CSS pixels; at 2x device pixel ratio
 * that is ~1280. Scaling to that is invisible on screen and turns a 4000px
 * photo into a fraction of the bytes. A preview is only ever displayed, never
 * zoomed in (the click opens the original), so this is the only size it needs
 * to be. */
export const PREVIEW_EDGE = 1280;

/** Content types this module can decode. Raster formats only: an SVG is a
 * document, not pixels — there is nothing to downscale, and rendering one
 * would mean deciding a script policy for it (see shared/attachments.ts). */
const DECODABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** Whether {@link renderPreview} can handle this type. */
export function isPreviewable(mimeType: string): boolean {
  return DECODABLE.has(mimeType);
}

/** The size to draw at: the source scaled so its longest edge is
 * {@link PREVIEW_EDGE}, or unchanged when it is already smaller. */
export function previewSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= PREVIEW_EDGE) return { width, height };
  const scale = PREVIEW_EDGE / longest;
  // Round up: a preview one pixel too narrow shows a hairline of background.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A downscaled copy of `source`, encoded the same way it came in (a PNG stays
 * a PNG so transparency survives; a JPEG stays a JPEG so a photo does not
 * become a multi-megabyte PNG).
 *
 * Returns `undefined` when there is nothing to produce: an unsupported type,
 * bytes the decoder cannot read, or an image already within
 * {@link PREVIEW_EDGE} — in that case the caller serves the original, which is
 * smaller than any re-encode would be.
 *
 * Asynchronous because it decodes through `loadImage`. Setting `Image.src`
 * decodes synchronously, and on Deno 2.9.8 a process that did so once
 * segfaults while shutting down (exit 139, intermittently) — the test runner
 * loses the whole file, and a server would die on its way out. `loadImage`
 * decodes on a microtask after `onload` and does not leave that state behind.
 */
export async function renderPreview(
  source: Uint8Array,
  mimeType: string,
): Promise<Uint8Array | undefined> {
  if (!isPreviewable(mimeType)) return undefined;
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    // Not decodable: the caller serves the original rather than a broken
    // image. An empty source rejects here too (loadImage refuses it).
    image = await loadImage(source);
  } catch {
    return undefined;
  }
  const width = image.width;
  const height = image.height;
  if (width <= 0 || height <= 0) return undefined;
  const size = previewSize(width, height);
  if (size.width === width && size.height === height) return undefined;

  const canvas = createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, size.width, size.height);
  if (mimeType === "image/jpeg") {
    // Quality 80: the usual point where a photograph stops being
    // distinguishable at display size, at a third of the bytes.
    return new Uint8Array(canvas.toBuffer("image/jpeg", 80));
  }
  if (mimeType === "image/webp") {
    return new Uint8Array(canvas.toBuffer("image/webp", 80));
  }
  // PNG (and GIF/BMP, which have no encoder here): encoded as PNG, which is
  // what the browser draws anyway. A GIF loses animation — the preview is a
  // still, and the click opens the original.
  return new Uint8Array(canvas.toBuffer("image/png"));
}
