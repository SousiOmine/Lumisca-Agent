import { removeDirRetry } from "@lumisca/core/test-utils";
import { join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { Assets, type AssetsManifest, bundleStylesCss } from "./assets.ts";

Deno.test("packaged assets use the startup-captured manifest path", async () => {
  const root = await Deno.makeTempDir();
  const manifestPath = join(root, "assets.json");
  const favicon = new Uint8Array([0, 1, 2, 255]);
  const manifest: AssetsManifest = {
    "app.js": "console.log('packaged');",
    "styles.css": "body { color: white; }",
    "favicon.png": btoa(String.fromCharCode(...favicon)),
  };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

  try {
    const assets = new Assets(root, join(root, "cache"), manifestPath);
    assertEquals(await assets.getAppJs(), manifest["app.js"]);
    assertEquals(await assets.getCss(), manifest["styles.css"]);
    assertEquals(await assets.getFavicon(), favicon);
  } finally {
    await removeDirRetry(root);
  }
});

async function writeStylesEntry(
  root: string,
  entry: string,
  parts: Record<string, string>,
): Promise<string> {
  await Deno.mkdir(join(root, "src", "styles"), { recursive: true });
  for (const [name, body] of Object.entries(parts)) {
    await Deno.writeTextFile(join(root, "src", "styles", name), body);
  }
  const entryPath = join(root, "src", "styles.css");
  await Deno.writeTextFile(entryPath, entry);
  return entryPath;
}

Deno.test("bundleStylesCss inlines imports in manifest order", async () => {
  const root = await Deno.makeTempDir();
  try {
    const entryPath = await writeStylesEntry(
      root,
      `/* entry */\n@import "./styles/b.css";\n@import "./styles/a.css";\n`,
      { "a.css": ".a { color: red; }\n", "b.css": ".b { color: blue; }\n" },
    );
    const css = await bundleStylesCss(entryPath);
    assertEquals(css.includes("@import"), false);
    // Cascade order follows the manifest, not the filenames.
    assertEquals(css.indexOf(".b {") < css.indexOf(".a {"), true);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bundleStylesCss passes a plain stylesheet through", async () => {
  const root = await Deno.makeTempDir();
  try {
    const entryPath = join(root, "styles.css");
    await Deno.writeTextFile(entryPath, "body { color: white; }\n");
    assertEquals(
      await bundleStylesCss(entryPath),
      "body { color: white; }\n",
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("bundleStylesCss rejects stray rules and escapes", async () => {
  const root = await Deno.makeTempDir();
  try {
    const withRule = await writeStylesEntry(
      root,
      `@import "./styles/a.css";\nbody { color: red; }\n`,
      { "a.css": ".a { color: red; }\n" },
    );
    await assertRejects(() => bundleStylesCss(withRule), Error);
    // An import pointing outside the web sources is rejected.
    await Deno.writeTextFile(join(root, "evil.css"), ".e {}\n");
    const escaping = await writeStylesEntry(
      root,
      `@import "../evil.css";\n`,
      { "a.css": ".a { color: red; }\n" },
    );
    await assertRejects(() => bundleStylesCss(escaping), Error);
  } finally {
    await removeDirRetry(root);
  }
});
