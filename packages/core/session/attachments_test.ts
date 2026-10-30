import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../shared/mod.ts";
import {
  MAX_ATTACHMENTS_PER_SESSION,
  SessionAttachmentStore,
} from "./attachments.ts";

/** Run `fn` against a store on a temp directory, and remove it afterwards. */
async function withStore(
  fn: (store: SessionAttachmentStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "lumisca-attachments-" });
  try {
    await fn(new SessionAttachmentStore(root), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("put stores the bytes under a name of its own", async () => {
  await withStore(async (store) => {
    const first = await store.put("s1", new Uint8Array([1, 2, 3]), "a.png");
    const second = await store.put("s1", new Uint8Array([4]), "b.png");
    // A fresh name per attachment: a message that names one keeps showing
    // what it showed.
    assert(first.name !== second.name);
    assertEquals(first.name.endsWith(".png"), true);
    assertEquals(first.size, 3);
    assertEquals(first.inline, true);
    assertEquals(first.displayName, "a.png");
  });
});

Deno.test("put keeps the extension the download needs", async () => {
  await withStore(async (store) => {
    // A file without an extension still gets one, so the route can name a
    // content type.
    const bare = await store.put("s1", new Uint8Array([1]), "Makefile");
    assertEquals(bare.name.endsWith(".bin"), true);
    assertEquals(bare.inline, false);
    assertEquals(bare.displayName, "Makefile");
  });
});

Deno.test("put refuses bytes over the limit", async () => {
  await withStore(async (store) => {
    await assertRejects(
      () =>
        store.put(
          "s1",
          new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
          "huge.bin",
        ),
      Error,
      "too large",
    );
  });
});

Deno.test("resolve refuses anything that is not a name the store made", async () => {
  await withStore(async (store) => {
    const ref = await store.put("s1", new Uint8Array([1]), "a.png");
    assert(await store.resolve("s1", ref.name) !== undefined);
    for (
      const name of [
        "../" + ref.name,
        "/etc/passwd",
        ref.name.toUpperCase(),
        "nope.png",
        "",
      ]
    ) {
      assertEquals(await store.resolve("s1", name), undefined, name);
    }
  });
});

Deno.test("resolve does not cross sessions", async () => {
  await withStore(async (store) => {
    const ref = await store.put("s1", new Uint8Array([1]), "a.png");
    assert(await store.resolve("s2", ref.name) === undefined);
  });
});

Deno.test("resolve reports the name the user knows and the content type", async () => {
  await withStore(async (store) => {
    const ref = await store.put("s1", new Uint8Array([1]), "report.pdf");
    const resolved = await store.resolve("s1", ref.name);
    assert(resolved !== undefined);
    // The stored name is random; the download carries the original.
    assertEquals(resolved.downloadName, "report.pdf");
    assertEquals(resolved.mimeType, "application/pdf");
  });
});

Deno.test("the session's cap refuses one more attachment", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < MAX_ATTACHMENTS_PER_SESSION; i++) {
      await store.put("s1", new Uint8Array([i % 256]), `f${i}.txt`);
    }
    await assertRejects(
      () => store.put("s1", new Uint8Array([0]), "one-more.txt"),
      Error,
      "already holds",
    );
  });
});

Deno.test("nothing is created until a session attaches", async () => {
  await withStore(async (store, root) => {
    // The store is lazy: a session that never sends a file leaves nothing.
    assertEquals(await store.resolve("s1", "000000000000.png"), undefined);
    let count = 0;
    for await (const _entry of Deno.readDir(root)) count++;
    assertEquals(count, 0);
  });
});

Deno.test("deleteSession drops one session's files only", async () => {
  await withStore(async (store, root) => {
    const kept = await store.put("s1", new Uint8Array([1]), "a.png");
    const gone = await store.put("s2", new Uint8Array([2]), "b.png");
    await store.deleteSession("s2");
    assert(await store.resolve("s1", kept.name) !== undefined);
    assertEquals(await store.resolve("s2", gone.name), undefined);
    // The other session's directory is intact.
    let keptFiles = 0;
    for await (const entry of Deno.readDir(join(root, "s1"))) {
      if (entry.isFile) keptFiles++;
    }
    assertEquals(keptFiles > 0, true);
  });
});
