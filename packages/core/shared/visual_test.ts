import { assertEquals } from "@std/assert";
import {
  isVisualExtension,
  MAX_VISUAL_ASSET_BYTES,
  MAX_VISUAL_SVG_BYTES,
  parseVisualRef,
  VISUAL_EXTENSIONS,
  visualMimeType,
  visualRef,
} from "./visual.ts";

Deno.test("visualMimeType accepts the names the store generates", () => {
  assertEquals(visualMimeType("9f3c2a1b4d5e.png"), "image/png");
  assertEquals(visualMimeType("9f3c2a1b4d5e.jpg"), "image/jpeg");
  assertEquals(visualMimeType("9f3c2a1b4d5e.jpeg"), "image/jpeg");
  assertEquals(visualMimeType("9f3c2a1b4d5e.gif"), "image/gif");
  assertEquals(visualMimeType("9f3c2a1b4d5e.webp"), "image/webp");
  assertEquals(visualMimeType("9f3c2a1b4d5e.bmp"), "image/bmp");
  assertEquals(visualMimeType("9f3c2a1b4d5e.svg"), "image/svg+xml");
});

Deno.test("visualMimeType rejects anything but an asset name", () => {
  // A path (or traversal) is never an asset: the shape check comes first, so
  // an image-looking name with a directory in it is refused.
  assertEquals(visualMimeType("../9f3c2a1b4d5e.png"), undefined);
  assertEquals(visualMimeType("out/9f3c2a1b4d5e.png"), undefined);
  assertEquals(visualMimeType("/etc/passwd"), undefined);
  // Shape mismatches: wrong length, non-hex, missing or unsupported type.
  assertEquals(visualMimeType("9f3c2a1b4d5.png"), undefined);
  assertEquals(visualMimeType("9f3c2a1b4d5e"), undefined);
  assertEquals(visualMimeType("9f3c2a1b4d5z.png"), undefined);
  assertEquals(visualMimeType("9f3c2a1b4d5e.PNG"), undefined);
  assertEquals(visualMimeType("9f3c2a1b4d5e.pdf"), undefined);
  assertEquals(visualMimeType(""), undefined);
});

Deno.test("parseVisualRef reads only visual references", () => {
  assertEquals(parseVisualRef("visual:9f3c2a1b4d5e.png"), "9f3c2a1b4d5e.png");
  // A normal image URL is not a visual reference.
  assertEquals(parseVisualRef("https://example.com/pic.png"), undefined);
  // The scheme alone is not enough: the name is validated too, so a
  // reference can never carry a path out of the store.
  assertEquals(parseVisualRef("visual:../../etc/passwd"), undefined);
  assertEquals(parseVisualRef("visual:"), undefined);
  assertEquals(parseVisualRef("visual:9f3c2a1b4d5e.pdf"), undefined);
  // Scheme matching is exact (no case folding, no prefix sharing).
  assertEquals(parseVisualRef("Visual:9f3c2a1b4d5e.png"), undefined);
  assertEquals(parseVisualRef("visualx:9f3c2a1b4d5e.png"), undefined);
});

Deno.test("visualRef is what parseVisualRef reads", () => {
  assertEquals(visualRef("9f3c2a1b4d5e.png"), "visual:9f3c2a1b4d5e.png");
  assertEquals(
    parseVisualRef(visualRef("9f3c2a1b4d5e.svg")),
    "9f3c2a1b4d5e.svg",
  );
});

Deno.test("isVisualExtension covers the map and nothing else", () => {
  for (const extension of VISUAL_EXTENSIONS) {
    assertEquals(isVisualExtension(extension), true);
    assertEquals(isVisualExtension(extension.toUpperCase()), true);
  }
  assertEquals(isVisualExtension(".pdf"), false);
  assertEquals(isVisualExtension("png"), false);
  assertEquals(isVisualExtension(""), false);
});

Deno.test("the raster limit exceeds the SVG limit", () => {
  // The asset route caps what it serves by these two constants; an SVG is
  // text and never needs the room a screenshot does.
  assertEquals(MAX_VISUAL_SVG_BYTES < MAX_VISUAL_ASSET_BYTES, true);
});
