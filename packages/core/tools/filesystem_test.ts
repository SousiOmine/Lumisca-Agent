import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { Sandbox } from "../workspace/sandbox.ts";
import { createReadFileTool } from "./filesystem.ts";

/** Minimal 1x1 transparent PNG (67 bytes). */
const MINI_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

function makeRead(root: string) {
  return createReadFileTool({ sandbox: new Sandbox([root]) });
}

async function fixture(): Promise<{ root: string; folder: string }> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-read-" }),
  );
  await Deno.writeFile(join(root, "pic.png"), MINI_PNG);
  await Deno.writeTextFile(join(root, "notes.txt"), "hello world\n");
  await Deno.writeTextFile(join(root, "drawing.svg"), "<svg></svg>");
  return { root, folder: basename(root) };
}

Deno.test("read_file passes raster images to the model as image blocks", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makeRead(root).execute("id", {
      path: `${folder}/pic.png`,
    });
    const images = result.content.filter((c) => c.type === "image");
    assertEquals(images.length, 1);
    assertEquals(images[0]?.mimeType, "image/png");
    const decoded = Uint8Array.from(
      atob(images[0]!.data),
      (c) => c.charCodeAt(0),
    );
    assertEquals(decoded, MINI_PNG);
    // A text note keeps the image visible in text-only UIs (CLI).
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert(text.includes("[image: pic.png"), `note missing: ${text}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read_file maps common image extensions to mime types", async () => {
  const { root, folder } = await fixture();
  try {
    for (
      const [ext, mime] of [
        [".jpg", "image/jpeg"],
        [".jpeg", "image/jpeg"],
        [".gif", "image/gif"],
        [".webp", "image/webp"],
        [".bmp", "image/bmp"],
        [".PNG", "image/png"], // case-insensitive
      ] as const
    ) {
      const name = `photo${ext}`;
      await Deno.writeFile(join(root, name), MINI_PNG);
      const result = await makeRead(root).execute("id", {
        path: `${folder}/${name}`,
      });
      const image = result.content.find((c) => c.type === "image");
      assertEquals(image?.mimeType, mime, ext);
      await Deno.remove(join(root, name));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read_file keeps text, SVG and partial reads on the text path", async () => {
  const { root, folder } = await fixture();
  try {
    const read = makeRead(root);
    for (const name of ["notes.txt", "drawing.svg"]) {
      const result = await read.execute("id", { path: `${folder}/${name}` });
      assertEquals(
        result.content.filter((c) => c.type === "image").length,
        0,
        `${name} must stay text`,
      );
    }
    // Partial reads of an image (offset/limit) stay text.
    const partial = await read.execute("id", {
      path: `${folder}/pic.png`,
      offset: 0,
    });
    assertEquals(partial.content.filter((c) => c.type === "image").length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
