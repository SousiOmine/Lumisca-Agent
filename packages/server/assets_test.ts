import { removeDirRetry } from "@lumisca/core/test-utils";
import { join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { Assets, type AssetsManifest, bundleStylesCss } from "./assets.ts";
import { contentEtag } from "./app-file-headers.ts";

Deno.test("packaged assets use the startup-captured manifest path", async () => {
  const root = await Deno.makeTempDir();
  const manifestPath = join(root, "assets.json");
  const favicon = new Uint8Array([0, 1, 2, 255]);
  const appJs = "console.log('packaged');";
  const chunk = "export const lazy = 1;";
  const manifest: AssetsManifest = {
    client: {
      "app.js": { body: appJs, etag: contentEtag(appJs) },
      "lazy-ABC123.js": { body: chunk, etag: contentEtag(chunk) },
    },
    "styles.css": "body { color: white; }",
    "favicon.png": btoa(String.fromCharCode(...favicon)),
  };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

  try {
    const assets = new Assets(root, join(root, "cache"), manifestPath);
    assertEquals((await assets.getClientFile("app.js"))?.body, appJs);
    assertEquals((await assets.getClientFile("lazy-ABC123.js"))?.body, chunk);
    // The manifest is the whole surface: a name it does not list is not a
    // file, whatever it looks like.
    assertEquals(await assets.getClientFile("missing.js"), undefined);
    assertEquals(await assets.getClientFile("../app.js"), undefined);
    // A prototype member (`Object.prototype.constructor`) is not a file
    // either — the manifest is a plain object, so the lookup has to ask for
    // an own property.
    assertEquals(await assets.getClientFile("constructor"), undefined);
    assertEquals(await assets.getCss(), manifest["styles.css"]);
    assertEquals(await assets.getFavicon(), favicon);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a manifest read that fails is retried instead of poisoning the process", async () => {
  const root = await Deno.makeTempDir();
  const manifestPath = join(root, "assets.json");
  const lateJs = "console.log('late');";
  try {
    // The packaged startup path: the manifest appears only after the first
    // request (a half-finished update, an unpacking installer) — the process
    // must serve its UI once it is there, not stay broken until a restart.
    const assets = new Assets(root, join(root, "cache"), manifestPath);
    await assertRejects(() => assets.getClientFile("app.js"));

    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        client: { "app.js": { body: lateJs, etag: contentEtag(lateJs) } },
      }),
    );
    assertEquals((await assets.getClientFile("app.js"))?.body, lateJs);
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
