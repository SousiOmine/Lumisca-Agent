import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { MAX_VISUAL_SVG_BYTES } from "../shared/mod.ts";
import { makeRealTempDir, MINI_PNG, removeDirRetry } from "../test-utils.ts";
import { SessionVisualStore } from "./visuals.ts";

/** Run `fn` against a store rooted in a fresh temp directory. */
async function withStore(
  fn: (store: SessionVisualStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await makeRealTempDir("lumisca-visuals-");
  try {
    await fn(new SessionVisualStore(root), root);
  } finally {
    await removeDirRetry(root);
  }
}

Deno.test("put names the asset and resolve finds it", async () => {
  await withStore(async (store) => {
    const name = await store.put("s1", MINI_PNG, ".png");
    // The name is what a `visual:` reference carries: a short hex base and
    // the extension the content type is derived from.
    assert(/^[0-9a-f]{12}\.png$/.test(name), name);
    const found = await store.resolve("s1", name);
    assertEquals(found?.mimeType, "image/png");
    assertEquals(
      (await Deno.readFile(found!.path)).byteLength,
      MINI_PNG.byteLength,
    );
  });
});

Deno.test("put normalizes the extension rather than trusting it", async () => {
  await withStore(async (store) => {
    const name = await store.put("s1", MINI_PNG, ".PNG");
    assertEquals(name.endsWith(".png"), true);
    assertEquals((await store.resolve("s1", name))?.mimeType, "image/png");
  });
});

Deno.test("every publish gets a name of its own", async () => {
  await withStore(async (store) => {
    const first = await store.put("s1", MINI_PNG, ".png");
    const second = await store.put("s1", MINI_PNG, ".png");
    // Never overwriting is the point: a message that linked the first copy
    // keeps showing what it showed.
    assertEquals(first === second, false);
    assertEquals((await store.resolve("s1", first)) !== undefined, true);
    assertEquals((await store.resolve("s1", second)) !== undefined, true);
  });
});

Deno.test("put refuses an unsupported extension", async () => {
  await withStore(async (store) => {
    await assertRejects(
      () => store.put("s1", MINI_PNG, ".pdf"),
      Error,
      "Unsupported visual extension",
    );
  });
});

Deno.test("put refuses bytes over the limit of their extension", async () => {
  await withStore(async (store) => {
    // An SVG's limit is the small one, so the oversized case stays cheap to
    // build here.
    const oversized = new Uint8Array(MAX_VISUAL_SVG_BYTES + 1);
    await assertRejects(
      () => store.put("s1", oversized, ".svg"),
      Error,
      "too large",
    );
    assertEquals(await store.resolve("s1", "000000000000.svg"), undefined);
  });
});

Deno.test("resolve refuses anything that is not an asset name", async () => {
  await withStore(async (store, root) => {
    const name = await store.put("s1", MINI_PNG, ".png");
    // A file the store did not name is not reachable through it, even when
    // it sits in the session's own directory.
    await Deno.writeTextFile(join(root, "s1", "notes.txt"), "secret");
    for (
      const requested of [
        "../notes.txt",
        "s1/../notes.txt",
        "notes.txt",
        name.replace(".png", ".pdf"),
        name.toUpperCase(),
        "",
      ]
    ) {
      assertEquals(
        await store.resolve("s1", requested),
        undefined,
        `${requested} must not resolve`,
      );
    }
  });
});

Deno.test("resolve does not cross sessions", async () => {
  await withStore(async (store) => {
    const name = await store.put("s1", MINI_PNG, ".png");
    assertEquals(await store.resolve("s2", name), undefined);
  });
});

Deno.test("resolve reports a missing asset as undefined", async () => {
  await withStore(async (store) => {
    assertEquals(
      await store.resolve("never-used", "9f3c2a1b4d5e.png"),
      undefined,
    );
  });
});

Deno.test("nothing is created until a session publishes", async () => {
  await withStore(async (store, root) => {
    // Reading never creates anything: an in-memory core (a temp root per
    // instance) leaves no directory behind unless a session shows an image.
    await store.resolve("s1", "9f3c2a1b4d5e.png");
    await store.deleteSession("s1");
    let exists = true;
    try {
      await Deno.stat(join(root, "s1"));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  });
});

Deno.test("deleteSession drops one session's assets only", async () => {
  await withStore(async (store) => {
    const kept = await store.put("s2", MINI_PNG, ".png");
    const dropped = await store.put("s1", MINI_PNG, ".png");
    await store.deleteSession("s1");
    assertEquals(await store.resolve("s1", dropped), undefined);
    assertEquals((await store.resolve("s2", kept))?.mimeType, "image/png");
    // Deleting again is a no-op, not an error: a workspace deletion and a
    // direct delete may both run for the same session.
    await store.deleteSession("s1");
  });
});
