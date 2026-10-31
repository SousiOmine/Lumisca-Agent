import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { MAX_AGENT_ICON_BYTES } from "../shared/mod.ts";
import { makeRealTempDir, MINI_PNG, removeDirRetry } from "../test-utils.ts";
import { AgentIconStore, MAX_AGENT_ICONS_PER_AGENT } from "./icons.ts";

/**
 * The agents' icons: one picture per agent, stored under a name the store
 * generated, and never a file that is not the image it claims to be.
 *
 * The upload route and the store both read the limits from
 * shared/agent-avatar.ts (tested there); what these cover is the store's own
 * job — refusing what it cannot serve, and answering a name it generated.
 */

/** Run `fn` against a store rooted in a fresh temp directory. */
async function withStore(
  fn: (store: AgentIconStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await makeRealTempDir("lumisca-icons-");
  try {
    await fn(new AgentIconStore(root), root);
  } finally {
    await removeDirRetry(root);
  }
}

/** A minimal JPEG: SOI plus enough bytes to be a file (the store checks the
 * signature, not the image). */
const MINI_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);

/** A minimal WebP: the RIFF container header with the WEBP form. */
const MINI_WEBP = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x1a,
  0x00,
  0x00,
  0x00, // size
  0x57,
  0x45,
  0x42,
  0x50, // "WEBP"
  0x56,
  0x50,
  0x38,
  0x20,
]);

Deno.test("icons: put names the icon and resolve finds it", async () => {
  await withStore(async (store) => {
    const name = await store.put("a1", MINI_PNG, ".png");
    // The name is what the row carries and what the route's URL ends in.
    assert(/^[0-9a-f]{12}\.png$/.test(name), name);
    const found = await store.resolve("a1", name);
    assertEquals(found?.mimeType, "image/png");
    assertEquals(
      (await Deno.readFile(found!.path)).byteLength,
      MINI_PNG.byteLength,
    );
  });
});

Deno.test("icons: every accepted format is stored and served with its type", async () => {
  await withStore(async (store) => {
    const cases: Array<[Uint8Array, string, string]> = [
      [MINI_PNG, ".png", "image/png"],
      [MINI_JPEG, ".jpg", "image/jpeg"],
      [MINI_JPEG, ".jpeg", "image/jpeg"],
      [MINI_WEBP, ".webp", "image/webp"],
      [
        new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
        ".gif",
        "image/gif",
      ],
      [new Uint8Array([0x42, 0x4d, 0x36, 0x00]), ".bmp", "image/bmp"],
    ];
    for (const [bytes, extension, mimeType] of cases) {
      const name = await store.put("a1", bytes, extension);
      assertEquals((await store.resolve("a1", name))?.mimeType, mimeType);
    }
  });
});

Deno.test("icons: the extension is normalized, not trusted", async () => {
  await withStore(async (store) => {
    const name = await store.put("a1", MINI_PNG, ".PNG");
    assertEquals(name.endsWith(".png"), true);
    assertEquals((await store.resolve("a1", name))?.mimeType, "image/png");
  });
});

Deno.test("icons: a format icons do not support is refused", async () => {
  await withStore(async (store) => {
    // SVG is a document that can carry script; the visual store accepts it,
    // the icon store must not.
    await assertRejects(
      () => store.put("a1", new TextEncoder().encode("<svg/>"), ".svg"),
      Error,
      "PNG, JPEG, GIF, WebP or BMP",
    );
    await assertRejects(
      () => store.put("a1", new TextEncoder().encode("%PDF-1.7"), ".pdf"),
      Error,
      "PNG, JPEG, GIF, WebP or BMP",
    );
  });
});

Deno.test("icons: bytes that are not the format they claim are refused", async () => {
  await withStore(async (store, root) => {
    // A renamed text file: the browser would report its own guess from the
    // extension, so the store is where "it is really a JPEG" is decided.
    await assertRejects(
      () => store.put("a1", new TextEncoder().encode("not an image"), ".png"),
      Error,
      "not a PNG image",
    );
    // A PNG uploaded as a JPEG.
    await assertRejects(
      () => store.put("a1", MINI_PNG, ".jpg"),
      Error,
      "not a JPG image",
    );
    // A RIFF container that is a WAV, not a WebP.
    await assertRejects(
      () =>
        store.put(
          "a1",
          new Uint8Array([
            0x52,
            0x49,
            0x46,
            0x46,
            0x00,
            0x00,
            0x00,
            0x00,
            0x57,
            0x41,
            0x56,
            0x45,
          ]),
          ".webp",
        ),
      Error,
      "not a WEBP image",
    );
    // Nothing was stored by the refusals: no file was written and no
    // directory was created.
    await assertRejects(() => Deno.stat(join(root, "a1")));
  });
});

Deno.test("icons: an oversized or empty file is refused, never truncated", async () => {
  await withStore(async (store) => {
    const tooBig = new Uint8Array(MAX_AGENT_ICON_BYTES + 1);
    tooBig.set(MINI_PNG.subarray(0, 8));
    await assertRejects(
      () => store.put("a1", tooBig, ".png"),
      Error,
      "too large",
    );
    await assertRejects(() => store.put("a1", new Uint8Array(), ".png"), Error);
  });
});

Deno.test("icons: resolve answers only names the store generated", async () => {
  await withStore(async (store) => {
    const name = await store.put("a1", MINI_PNG, ".png");
    assert(name !== "");
    // A path, a traversal, a name of the wrong shape, an extension icons do
    // not serve: none of them is an address this store hands out.
    for (
      const asked of [
        "../../etc/passwd",
        "000000000000.png/../../x",
        "passwd",
        "000000000000.svg",
        "9f3c2a1b4d5e.PNG",
        "",
      ]
    ) {
      assertEquals(await store.resolve("a1", asked), undefined, asked);
    }
    // A real name, but another agent's.
    assertEquals(await store.resolve("a2", name), undefined);
  });
});

Deno.test("icons: remove drops one file and is quiet when it is gone", async () => {
  await withStore(async (store) => {
    const first = await store.put("a1", MINI_PNG, ".png");
    const second = await store.put("a1", MINI_PNG, ".png");
    await store.remove("a1", first);
    assertEquals(await store.resolve("a1", first), undefined);
    assert((await store.resolve("a1", second)) !== undefined);
    // Removing it twice (an interrupted replacement) is not an error.
    await store.remove("a1", first);
  });
});

Deno.test("icons: an agent that never uploaded one has no directory", async () => {
  await withStore(async (store, root) => {
    assertEquals(await store.resolve("a1", "9f3c2a1b4d5e.png"), undefined);
    await assertRejects(() => Deno.stat(join(root, "a1")));
    // Deleting an agent that never had a picture is a no-op, not a failure.
    await store.deleteAgent("a1");
  });
});

Deno.test("icons: deleteAgent drops that agent's files only", async () => {
  await withStore(async (store, root) => {
    const mine = await store.put("a1", MINI_PNG, ".png");
    const other = await store.put("a2", MINI_PNG, ".png");
    await store.deleteAgent("a1");
    assertEquals(await store.resolve("a1", mine), undefined);
    assert((await store.resolve("a2", other)) !== undefined);
    await assertRejects(() => Deno.stat(join(root, "a1")));
  });
});

Deno.test("icons: the per-agent cap keeps a loop from filling the disk", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < MAX_AGENT_ICONS_PER_AGENT; i++) {
      await store.put("a1", MINI_PNG, ".png");
    }
    // Not a silent overwrite: the writer must fail so the user learns the
    // file was not changed.
    await assertRejects(
      () => store.put("a1", MINI_PNG, ".png"),
      Error,
      "already holds",
    );
  });
});
