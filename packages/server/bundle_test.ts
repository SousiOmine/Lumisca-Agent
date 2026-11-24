import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, join as pathJoin } from "node:path";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { assert, assertEquals } from "@std/assert";
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
  await fsp.writeFile(eager, `export const eager = "eager";\n`);
  await fsp.writeFile(lazy, `export const lazy = "lazy";\n`);
  await fsp.writeFile(
    entry,
    `import { eager } from "./eager.ts";\n` +
      `export const load = () => import("./lazy.ts");\n` +
      `console.log(eager);\n`,
  );
  return entry;
}

/** The theme script the page loads before its stylesheet. Kept trivial in
 * this test: the contract is that it is a second, standalone entry. */
async function writeThemeFixture(root: string): Promise<string> {
  const entry = join(root, "theme.ts");
  await fsp.writeFile(entry, `console.log("theme");\n`);
  return entry;
}

test("bundleClient splits a dynamic import out of the entry chunk", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  try {
    const entry = await writeFixture(root);
    const themeEntry = await writeThemeFixture(root);
    const outdir = join(root, "out");
    const result = await bundleClient({ cwd: root, entry, themeEntry, outdir });

    // The page loads the entry by this name (render.ts's script tag), so it
    // must not depend on a hash the build happens to pick.
    assertEquals(result.entry, "app.js");
    assert(result.files.includes("app.js"), result.files.join(", "));
    // The theme script is a file of its own, with a stable name the head can
    // load as a classic script.
    assertEquals(result.themeEntry, "theme.js");
    assert(result.files.includes("theme.js"), result.files.join(", "));
    // The dynamic import is its own file: a lazy chunk. If esbuild inlined it
    // (no `splitting`), the entry would be the only output and its size would
    // carry the lazy code — the regression this guards.
    const chunks = result.files.filter((name) => name.startsWith("lazy-"));
    assertEquals(chunks.length, 1, result.files.join(", "));

    const entryBody = await fsp.readFile(join(outdir, "app.js"), "utf8");
    assert(entryBody.includes("./lazy-"), entryBody);
    // A dynamic import survives the build: the browser fetches the chunk when
    // the code reaches it, not when the page loads.
    assert(entryBody.includes("import("), entryBody);
    assertEquals(entryBody.includes('lazy"'), false, entryBody);
  } finally {
    await removeDirRetry(root);
  }
});

test("bundleClient names the entry chunk app.js whatever the entry is", async () => {
  // The script tag render.ts writes is a fixed `/assets/app.js`: it must not
  // follow the entry's own file name (client.tsx → client.js) or a packaged
  // server would load a 404.
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  try {
    const entry = join(root, "main.ts");
    await fsp.writeFile(entry, `console.log("hi");\n`);
    const themeEntry = await writeThemeFixture(root);
    const outdir = join(root, "out");
    const result = await bundleClient({ cwd: root, entry, themeEntry, outdir });
    assertEquals(result.entry, "app.js");
    assertEquals(result.files, ["app.js", "theme.js"]);
    assert((await fsp.readFile(join(outdir, "app.js"), "utf8")).includes("hi"));
  } finally {
    await removeDirRetry(root);
  }
});
