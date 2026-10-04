/**
 * The computer-use image pipeline: raw BGRA frames from a host become a
 * PNG the model can read, scaled to stay inside the vision providers'
 * image budget.
 *
 * Deliberately independent of @napi-rs/canvas (the PDF renderer's Skia
 * binding): Windows Skia loads `icudtl.dat` at library load and aborts the
 * whole process when it is missing (see pdf/tools.ts), which must never be
 * a failure mode of a screenshot. The encoder here is ~100 lines of PNG
 * (IHDR/IDAT/IEND with zlib from CompressionStream) with no native
 * dependency at all.
 *
 * The scale is the one piece of information the agent needs to convert
 * what it sees into screen coordinates, so it is computed here and carried
 * in the result: `screen = round(image / scale) + (screen.x, screen.y)`.
 */
import type { RawCapture } from "./types.ts";
import { deflateSync } from "node:zlib";

/** Longest side of the image a capture produces by default. Chosen to stay
 * inside the vision providers' image budget (1568 px long edge / ~1.15 MP):
 * a larger image is downscaled by the provider AFTER it leaves Lumisca, and
 * the model's pixel readings would then no longer match the coordinates it
 * must pass to computer_act. */
export const DEFAULT_MAX_DIMENSION = 1280;

/** Smallest accepted max_dimension (anything below is a mistake, not a
 * request for a thumbnail). */
export const MIN_MAX_DIMENSION = 64;
/** Largest accepted max_dimension (the capture is never upscaled, so this
 * only bounds the encode work). */
export const MAX_MAX_DIMENSION = 4096;

/** Largest region the host will capture, per side. A 8K-wide virtual
 * desktop is already beyond any real setup; anything larger is a bug in the
 * caller's arguments. */
export const MAX_CAPTURE_DIMENSION = 16384;

/** An encoded capture plus the mapping back to screen pixels. */
export interface EncodedCapture {
  png: Uint8Array;
  /** Image size in pixels (after scaling). */
  width: number;
  height: number;
  /** Screen pixels per image pixel on the x axis: the value the agent
   * divides its image coordinates by. Exact by construction
   * (width = round(sourceWidth × scale)), while y can differ by at most one
   * image pixel — below one screen pixel at any scale Lumisca produces. */
  scale: number;
}

/**
 * Encode one raw capture as a PNG, scaled so its longest side is at most
 * `maxDimension`. The source is never upscaled: a small region is returned
 * 1:1 (scale 1), which is what makes precise clicking possible.
 */
export function encodeCapture(
  raw: RawCapture,
  maxDimension: number,
): EncodedCapture {
  const rgb = bgraToRgb(raw.pixels, raw.width, raw.height);
  const longest = Math.max(raw.width, raw.height);
  const scale = Math.min(1, maxDimension / longest);
  const width = Math.max(1, Math.round(raw.width * scale));
  const height = Math.max(1, Math.round(raw.height * scale));
  const scaled = width === raw.width && height === raw.height
    ? rgb
    : resizeRgb(rgb, raw.width, raw.height, width, height);
  return {
    png: encodePng(scaled, width, height),
    width,
    height,
    // The x ratio, recomputed from the rounded size so the mapping the tool
    // reports is exactly the one the image has.
    scale: width / raw.width,
  };
}

/** Drop the alpha channel and swap BGR to RGB. Screenshots are opaque, so
 * the PNG is written as truecolor RGB (3 bytes per pixel) instead of RGBA —
 * a third less data to deflate and ship. */
export function bgraToRgb(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(
      `BGRA buffer size mismatch: got ${pixels.length} bytes, expected ${expected}`,
    );
  }
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = pixels[i + 2]!;
    out[j + 1] = pixels[i + 1]!;
    out[j + 2] = pixels[i]!;
  }
  return out;
}

/**
 * Downscale an RGB buffer with a box filter (each destination pixel is the
 * average of the source pixels it covers). Averaging — rather than picking
 * the nearest source pixel — is what keeps small UI text legible after a
 * 2× reduction, which is the whole point of the default 1280 px budget.
 */
export function resizeRgb(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return src;
  const out = new Uint8Array(dstWidth * dstHeight * 3);
  for (let dy = 0; dy < dstHeight; dy++) {
    const y0 = Math.floor((dy * srcHeight) / dstHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * srcHeight) / dstHeight));
    for (let dx = 0; dx < dstWidth; dx++) {
      const x0 = Math.floor((dx * srcWidth) / dstWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * srcWidth) / dstWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * srcWidth;
        for (let x = x0; x < x1; x++) {
          const i = (row + x) * 3;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          count++;
        }
      }
      const o = (dy * dstWidth + dx) * 3;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
    }
  }
  return out;
}

const PNG_SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

/** Encode an RGB buffer as an 8-bit truecolor PNG (no interlace, filter
 * type 0 on every scanline). Synchronous: the compressor is node:zlib. */
export function encodePng(
  rgb: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(
      `RGB buffer size mismatch: got ${rgb.length} bytes, expected ${expected}`,
    );
  }
  // PNG scanlines carry a filter byte; "None" keeps the encoder trivial and
  // still compresses well (zlib does the work).
  const stride = width * 3;
  const filtered = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    filtered[rowStart] = 0;
    filtered.set(
      rgb.subarray(y * stride, (y + 1) * stride),
      rowStart + 1,
    );
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = zlibDeflate(filtered);
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** Deflate with the zlib wrapper (RFC 1950), which is what PNG's IDAT
 * requires. node:zlib is a Deno built-in and the same native zlib the rest
 * of the stack uses — no stream plumbing and no hand-rolled compressor. */
function zlibDeflate(data: Uint8Array): Uint8Array {
  return deflateSync(data);
}

/** One PNG chunk: length, type, data, CRC of type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) {
    throw new Error(`PNG chunk type must be 4 characters: ${type}`);
  }
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** CRC-32 (PNG's polynomial, reflected) over `data`. */
export function crc32(data: Uint8Array): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The CRC table, built once per process (256 entries). */
let crcTableCache: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (crcTableCache !== undefined) return crcTableCache;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTableCache = table;
  return table;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
