import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  bgraToRgb,
  crc32,
  DEFAULT_MAX_DIMENSION,
  encodeCapture,
  encodePng,
  resizeRgb,
} from "./image.ts";
import type { RawCapture } from "./types.ts";
import { findCanvasIcuDataFile } from "../pdf/tools.ts";
import { inflateSync } from "node:zlib";

/** @napi-rs/canvas is a real, independent PNG decoder already in the stack
 * (the PDF renderer uses it). Decoding our output with it proves the
 * encoder is correct rather than merely self-consistent. Windows Skia
 * aborts the whole process when icudtl.dat is missing, so the import is
 * gated on the same lookup the PDF renderer guards with. */
const canvasModule = await (async () => {
  if (Deno.build.os === "windows" && findCanvasIcuDataFile() === undefined) {
    return undefined;
  }
  try {
    return await import("@napi-rs/canvas");
  } catch {
    return undefined;
  }
})();

/** A raw BGRA frame from an RGB image, row by row. */
function rawFromRgb(
  rgb: number[],
  width: number,
  height: number,
  screen = { x: 0, y: 0, width, height },
): RawCapture {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgb[i * 3 + 2]!; // B
    pixels[i * 4 + 1] = rgb[i * 3 + 1]!; // G
    pixels[i * 4 + 2] = rgb[i * 3]!; // R
    pixels[i * 4 + 3] = 255;
  }
  return { screen, pixels, width, height };
}

interface Chunk {
  type: string;
  data: Uint8Array;
  crcOk: boolean;
}

function parseChunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let offset = 8; // skip the signature
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = view.getUint32(offset + 8 + length);
    chunks.push({
      type,
      data,
      crcOk: stored === crc32(png.subarray(offset + 4, offset + 8 + length)),
    });
    offset += 12 + length;
  }
  return chunks;
}

// --- PNG structure ----------------------------------------------------------

Deno.test("encodePng writes a well-formed truecolor PNG", () => {
  // 2×2: red, green / blue, white.
  const rgb = new Uint8Array([
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    255,
    255,
    255,
  ]);
  const png = encodePng(rgb, 2, 2);

  assertEquals(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG signature",
  );

  const chunks = parseChunks(png);
  assertEquals(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  for (const chunk of chunks) {
    assert(chunk.crcOk, `chunk ${chunk.type} must carry a valid CRC`);
  }

  const ihdr = chunks[0]!.data;
  assertEquals(ihdr.length, 13);
  const header = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  assertEquals(header.getUint32(0), 2, "width");
  assertEquals(header.getUint32(4), 2, "height");
  assertEquals(ihdr[8], 8, "bit depth");
  assertEquals(ihdr[9], 2, "color type: truecolor RGB");
  assertEquals(ihdr[10], 0, "compression method");
  assertEquals(ihdr[11], 0, "filter method");
  assertEquals(ihdr[12], 0, "interlace");
  assertEquals(chunks[2]!.data.length, 0, "IEND carries no data");

  // The zlib stream is what PNG requires, and it inflates back to the
  // filtered scanlines the encoder built (filter byte 0 + RGB row).
  const filtered = inflateSync(chunks[1]!.data);
  assertEquals(filtered.length, 2 * (1 + 2 * 3));
  assertEquals(filtered[0], 0, "filter type None");
  assertEquals([...filtered.subarray(1, 7)], [...rgb.subarray(0, 6)]);
  assertEquals(filtered[7], 0, "second row filter byte");
  assertEquals([...filtered.subarray(8, 14)], [...rgb.subarray(6, 12)]);
});

Deno.test("encodePng output decodes back to the same pixels", {
  ignore: canvasModule === undefined,
}, async () => {
  const canvas = canvasModule!;
  const rgb = new Uint8Array(3 * 4 * 3);
  for (let i = 0; i < 12; i++) {
    rgb[i * 3] = (i * 20) % 256;
    rgb[i * 3 + 1] = (i * 40) % 256;
    rgb[i * 3 + 2] = (i * 60) % 256;
  }
  const png = encodePng(rgb, 4, 3);

  const image = await canvas.loadImage(png);
  const target = canvas.createCanvas(4, 3);
  const ctx = target.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const decoded = ctx.getImageData(0, 0, 4, 3).data;
  for (let i = 0; i < 12; i++) {
    assertEquals(
      [decoded[i * 4], decoded[i * 4 + 1], decoded[i * 4 + 2]],
      [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]],
      `pixel ${i}`,
    );
    assertEquals(decoded[i * 4 + 3], 255, `pixel ${i} alpha`);
  }
});

// --- channel conversion -----------------------------------------------------

Deno.test("bgraToRgb swaps channels and drops alpha", () => {
  const pixels = new Uint8Array([
    0x10,
    0x20,
    0x30,
    0x40, // B G R A
    0x01,
    0x02,
    0x03,
    0xff,
  ]);
  assertEquals(
    [...bgraToRgb(pixels, 2, 1)],
    [0x30, 0x20, 0x10, 0x03, 0x02, 0x01],
  );
});

Deno.test("bgraToRgb refuses a buffer that does not match its size", () => {
  assertThrows(
    () => bgraToRgb(new Uint8Array(3), 1, 1),
    Error,
    "BGRA buffer size mismatch",
  );
});

Deno.test("encodePng refuses a buffer that does not match its size", async () => {
  await assertRejects(
    () => Promise.resolve().then(() => encodePng(new Uint8Array(3), 2, 2)),
    Error,
    "RGB buffer size mismatch",
  );
});

// --- scaling ----------------------------------------------------------------

Deno.test("resizeRgb averages the source blocks", () => {
  // 4×4 pixel checkerboard of two greys: a 2×2 box filter must average each
  // block (two 0s and two 200s) into 100 — picking a nearest pixel would
  // return 0 or 200 instead.
  const src = new Uint8Array(4 * 4 * 3);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const value = (x + y) % 2 === 0 ? 0 : 200;
      const i = (y * 4 + x) * 3;
      src[i] = src[i + 1] = src[i + 2] = value;
    }
  }
  const out = resizeRgb(src, 4, 4, 2, 2);
  assertEquals(out.length, 2 * 2 * 3);
  assertEquals(
    [...out],
    [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  );
});

Deno.test("resizeRgb returns the source when the size is unchanged", () => {
  const src = new Uint8Array(9);
  assertEquals(resizeRgb(src, 1, 3, 1, 3), src);
});

// --- encodeCapture ----------------------------------------------------------

Deno.test("encodeCapture keeps a small region at 1:1", () => {
  const raw = rawFromRgb(
    new Array(4 * 2 * 3).fill(120),
    4,
    2,
    { x: -100, y: 50, width: 4, height: 2 },
  );
  const encoded = encodeCapture(raw, DEFAULT_MAX_DIMENSION);
  assertEquals([encoded.width, encoded.height], [4, 2]);
  assertEquals(encoded.scale, 1, "no upscaling: the mapping is 1:1");
  assertEquals(parseChunks(encoded.png)[0]!.data.length, 13);
});

Deno.test("encodeCapture fits the longest side and reports the exact ratio", () => {
  // A 2560×1440 display at the default budget: exactly half size, so the
  // agent's image coordinates are exactly double the screen offset.
  const raw = rawFromRgb(new Array(8 * 4 * 3).fill(30), 8, 4);
  const encoded = encodeCapture(raw, 4);
  assertEquals([encoded.width, encoded.height], [4, 2]);
  assertEquals(encoded.scale, 0.5);
  // screen = image / scale + origin → image (2, 1) is screen (4, 2).
  assertEquals(
    [Math.round(2 / encoded.scale), Math.round(1 / encoded.scale)],
    [4, 2],
  );
});

Deno.test("encodeCapture never upscales below the budget", () => {
  const raw = rawFromRgb(new Array(3 * 2 * 3).fill(200), 3, 2);
  const encoded = encodeCapture(raw, 1280);
  assertEquals([encoded.width, encoded.height], [3, 2]);
  assertEquals(encoded.scale, 1);
});
