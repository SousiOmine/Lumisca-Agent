import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { bundleClient } from "./bundle.ts";

/** A miniature entry with one static and one dynamic import. The real client
 * is too slow to bundle in a unit test (and its chunk names are content
 * hashes), so the contract `bundleClient` promises the server is checked on
 * the smallest input that exercises splitting: the entry chunk, plus one
 * chunk that only a dynamic import reaches. */
async function writeFixture(root: string): Promise<string> {
  const entry = join(root, "entry.ts");
  const eager = join(root, "eager.ts");
  const lazy = join(root, "lazy.ts");
  await Deno.writeTextFile(eager, `export const eager = "eager";\n`);
  await Deno.writeTextFile(lazy, `export const lazy = "lazy";\n`);
  await Deno.writeTextFile(
    entry,
    `import { eager } from "./eager.ts";\n` +
      `export const load = () => import("./lazy.ts");\n` +
      `console.log(eager);\n`,
  );
  return entry;
}

Deno.test("bundleClient splits a dynamic import out of the entry chunk", async () => {
  const root = await Deno.makeTempDir();
  try {
    const entry = await writeFixture(root);
    const outdir = join(root, "out");
    const result = await bundleClient({ cwd: root, entry, outdir });

    // The page loads the entry by this name (render.ts's script tag), so it
    // must not depend on a hash the build happens to pick.
    assertEquals(result.entry, "app.js");
    assert(result.files.includes("app.js"), result.files.join(", "));
    // The dynamic import is its own file: a lazy chunk. If esbuild inlined it
    // (no `splitting`), the entry would be the only output and its size would
    // carry the lazy code — the regression this guards.
    const chunks = result.files.filter((name) => name.startsWith("lazy-"));
    assertEquals(chunks.length, 1, result.files.join(", "));

    const entryBody = await Deno.readTextFile(join(outdir, "app.js"));
    assert(entryBody.includes("./lazy-"), entryBody);
    // A dynamic import survives the build: the browser fetches the chunk when
    // the code reaches it, not when the page loads.
    assert(entryBody.includes("import("), entryBody);
    assertEquals(entryBody.includes('lazy"'), false, entryBody);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bundleClient names the entry chunk app.js whatever the entry is", async () => {
  // The script tag render.ts writes is a fixed `/assets/app.js`: it must not
  // follow the entry's own file name (client.tsx → client.js) or a packaged
  // server would load a 404.
  const root = await Deno.makeTempDir();
  try {
    const entry = join(root, "main.ts");
    await Deno.writeTextFile(entry, `console.log("hi");\n`);
    const outdir = join(root, "out");
    const result = await bundleClient({ cwd: root, entry, outdir });
    assertEquals(result.entry, "app.js");
    assertEquals(result.files, ["app.js"]);
    assert((await Deno.readTextFile(join(outdir, "app.js"))).includes("hi"));
  } finally {
    await removeDirRetry(root);
  }
});
