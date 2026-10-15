import { basename, dirname, join } from "node:path";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { MAX_VISUAL_SVG_BYTES, parseVisualRef } from "../shared/mod.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { SessionVisualStore } from "../session/visuals.ts";
import {
  makeRealTempDir,
  MINI_PNG,
  removeDirRetry,
  toolText,
} from "../test-utils.ts";
import { createVisualTool } from "./visual.ts";

interface Fixture {
  /** Workspace root (also the sandbox root). */
  root: string;
  /** The sandbox root's own name: the first segment of a relative path. */
  folder: string;
  store: SessionVisualStore;
  tool: ReturnType<typeof createVisualTool>;
}

/** Run `fn` against a workspace holding one file and a visual tool wired to
 * a store of its own — never inside the workspace, which is the point of the
 * store (a published asset must not appear in the user's project). */
async function withFixture(
  file: string,
  fn: (fixture: Fixture) => Promise<void>,
  bytes: Uint8Array = MINI_PNG,
): Promise<void> {
  const root = await makeRealTempDir("lumisca-visual-");
  const storeRoot = await makeRealTempDir("lumisca-visual-store-");
  try {
    const path = join(root, file);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(path, bytes);
    const store = new SessionVisualStore(storeRoot);
    await fn({
      root,
      folder: basename(root),
      store,
      tool: createVisualTool({
        sandbox: new Sandbox([root]),
        store,
        sessionId: "s1",
      }),
    });
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(storeRoot);
  }
}

Deno.test("visual publishes a workspace image and returns the snippet", async () => {
  await withFixture("chart.png", async ({ folder, store, tool }) => {
    const result = await tool.execute("id", {
      path: `${folder}/chart.png`,
      caption: "実行時間の内訳",
    });
    const text = toolText(result);
    const ref = String(result.details.ref);
    const name = parseVisualRef(ref)!;
    assertStringIncludes(text, ref);
    // The snippet is what the agent pastes into its reply.
    assertStringIncludes(text, `![実行時間の内訳](${ref})`);
    assertEquals(name.endsWith(".png"), true);
    const stored = await store.resolve("s1", name);
    assertEquals(stored?.mimeType, "image/png");
    // The copy is what the reply shows from now on: the bytes travel with
    // the session, not with the file the agent happened to read.
    assertEquals(
      (await Deno.readFile(stored!.path)).byteLength,
      MINI_PNG.byteLength,
    );
  });
});

Deno.test("visual names the image after the file without a caption", async () => {
  await withFixture("bench/chart.png", async ({ folder, tool }) => {
    const result = await tool.execute("id", {
      path: `${folder}/bench/chart.png`,
    });
    assertStringIncludes(toolText(result), "![chart.png](visual:");
  });
});

Deno.test("visual keeps the snippet pasteable whatever the caption holds", async () => {
  await withFixture("chart.png", async ({ folder, tool }) => {
    // Brackets and line breaks would break the markdown the agent pastes.
    const result = await tool.execute("id", {
      path: `${folder}/chart.png`,
      caption: "a ] caption\nwith breaks",
    });
    assertStringIncludes(toolText(result), "![a caption with breaks](visual:");
    // A caption that is nothing but punctuation falls back to the name.
    const blank = await tool.execute("id", {
      path: `${folder}/chart.png`,
      caption: "[]\n",
    });
    assertStringIncludes(toolText(blank), "![chart.png](visual:");
  });
});

Deno.test("visual publishes a diagram file too", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><title>D</title></svg>';
  await withFixture(
    "diagram.svg",
    async ({ folder, store, tool }) => {
      const result = await tool.execute("id", {
        path: `${folder}/diagram.svg`,
      });
      const name = parseVisualRef(String(result.details.ref))!;
      assertEquals(
        (await store.resolve("s1", name))?.mimeType,
        "image/svg+xml",
      );
    },
    new TextEncoder().encode(source),
  );
});

Deno.test("visual refuses a path outside the workspace", async () => {
  await withFixture("chart.png", async ({ root, folder, tool }) => {
    // A relative path whose first segment names no workspace folder...
    await assertRejects(
      () => tool.execute("id", { path: "elsewhere/outside.png" }),
      Error,
      "Unknown workspace folder",
    );
    // ...and an absolute path outside every root.
    await assertRejects(
      () => tool.execute("id", { path: join(root, "..", "outside.png") }),
      Error,
      "outside the workspace",
    );
    // The workspace's own file still publishes: the refusal is about the
    // path, not about the tool.
    const result = await tool.execute("id", { path: `${folder}/chart.png` });
    assert(result.details.ref !== undefined);
  });
});

Deno.test("visual refuses what it cannot show", async () => {
  await withFixture("notes.pdf", async ({ folder, tool }) => {
    await assertRejects(
      () => tool.execute("id", { path: `${folder}/notes.pdf` }),
      Error,
      "can be published",
    );
    await assertRejects(
      () => tool.execute("id", { path: `${folder}/missing.png` }),
      Error,
      "Path does not exist",
    );
    await assertRejects(
      () => tool.execute("id", { path: folder }),
      Error,
      "Is a directory",
    );
  });
});

Deno.test("visual refuses an oversized image", async () => {
  // One byte over the SVG limit (proving the raster limit the same way would
  // need a 4 MiB fixture).
  await withFixture(
    "big.svg",
    async ({ folder, tool }) => {
      await assertRejects(
        () => tool.execute("id", { path: `${folder}/big.svg` }),
        Error,
        "Too large to publish",
      );
    },
    new Uint8Array(MAX_VISUAL_SVG_BYTES + 1),
  );
});

Deno.test("visual refuses an SVG that carries a script", async () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg">' +
    "<script>alert(1)</script></svg>";
  await withFixture(
    "diagram.svg",
    async ({ folder, tool }) => {
      await assertRejects(
        () => tool.execute("id", { path: `${folder}/diagram.svg` }),
        Error,
        "<script>",
      );
    },
    new TextEncoder().encode(source),
  );
});
