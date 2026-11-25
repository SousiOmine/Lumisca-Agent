import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, join as pathJoin } from "node:path";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { contentEtag } from "./app-file-headers.ts";
import {
  Assets,
  type AssetsManifest,
  bundleStyles,
  bundleStylesCss,
} from "./assets.ts";

test("packaged assets use the startup-captured manifest path", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  const manifestPath = join(root, "assets.json");
  const favicon = new Uint8Array([0, 1, 2, 255]);
  const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 8]);
  const appJs = "console.log('packaged');";
  const chunk = "export const lazy = 1;";
  const worker = "self.addEventListener('fetch', () => {});";
  const manifest: AssetsManifest = {
    client: {
      "app.js": { body: appJs, etag: contentEtag(appJs) },
      "lazy-ABC123.js": { body: chunk, etag: contentEtag(chunk) },
    },
    "styles.css": "body { color: white; }",
    "favicon.png": btoa(String.fromCharCode(...favicon)),
    pwaIcons: { "icon-192.png": btoa(String.fromCharCode(...icon)) },
    fonts: {},
    "sw.js": worker,
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));

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
    assertEquals(await assets.getPwaIcon("icon-192.png"), icon);
    // A name outside the build's list is an unknown URL (the route answers
    // 404), while a listed icon the package lacks is a broken build and
    // fails loudly, like a missing favicon.
    assertEquals(await assets.getPwaIcon("icon-1024.png"), undefined);
    assertEquals(await assets.getPwaIcon("../favicon.png"), undefined);
    await assertRejects(() => assets.getPwaIcon("icon-512.png"));
    assertEquals(await assets.getServiceWorker(), worker);
  } finally {
    await removeDirRetry(root);
  }
});

test("a manifest read that fails is retried instead of poisoning the process", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  const manifestPath = join(root, "assets.json");
  const lateJs = "console.log('late');";
  try {
    // The packaged startup path: the manifest appears only after the first
    // request (a half-finished update, an unpacking installer) — the process
    // must serve its UI once it is there, not stay broken until a restart.
    const assets = new Assets(root, join(root, "cache"), manifestPath);
    await assertRejects(() => assets.getClientFile("app.js"));

    await fsp.writeFile(
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
  await fsp.mkdir(join(root, "src", "styles"), { recursive: true });
  for (const [name, body] of Object.entries(parts)) {
    await fsp.writeFile(join(root, "src", "styles", name), body);
  }
  const entryPath = join(root, "src", "styles.css");
  await fsp.writeFile(entryPath, entry);
  return entryPath;
}

test("bundleStylesCss inlines imports in manifest order", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
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

test("bundleStylesCss passes a plain stylesheet through", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  try {
    const entryPath = join(root, "styles.css");
    await fsp.writeFile(entryPath, "body { color: white; }\n");
    assertEquals(await bundleStylesCss(entryPath), "body { color: white; }\n");
  } finally {
    await removeDirRetry(root);
  }
});

test("bundleStylesCss rejects stray rules and escapes", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  try {
    const withRule = await writeStylesEntry(
      root,
      `@import "./styles/a.css";\nbody { color: red; }\n`,
      { "a.css": ".a { color: red; }\n" },
    );
    await assertRejects(() => bundleStylesCss(withRule), Error);
    // An import pointing outside the web sources is rejected.
    await fsp.writeFile(join(root, "evil.css"), ".e {}\n");
    const escaping = await writeStylesEntry(root, `@import "../evil.css";\n`, {
      "a.css": ".a { color: red; }\n",
    });
    await assertRejects(() => bundleStylesCss(escaping), Error);
  } finally {
    await removeDirRetry(root);
  }
});

test("a dependency's stylesheet is inlined with its fonts reported", async () => {
  const styles = await bundleStyles(
    join(process.cwd(), "packages", "web", "src", "styles.css"),
  );
  // KaTeX's rules arrive whole, with the font URLs pointed at the route the
  // server answers from.
  assertEquals(styles.css.includes(".katex-display"), true);
  assertEquals(
    styles.css.includes("url(/assets/KaTeX_Main-Regular.woff2)"),
    true,
  );
  // The sources this build does not ship are gone: the browser would ask for
  // a .woff or .ttf after the woff2 it already has.
  assertEquals(/url\(["']?fonts\//.test(styles.css), false);
  const path = styles.fonts.get("KaTeX_Main-Regular.woff2");
  assert(path !== undefined, "the font file must be reported");
  assertEquals((await fsp.stat(path)).size > 1000, true);
  assertEquals(styles.fonts.size >= 10, true);
});

test("the fonts are read from the checkout, or from the manifest", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "tmp-"));
  const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]);
  const manifestPath = join(root, "assets.json");
  try {
    // A checkout: the stylesheet names the files beside the dependency, so a
    // name it does not use is not a file.
    const checkout = new Assets(process.cwd(), join(root, "cache"));
    const bytes = await checkout.getFont("KaTeX_Main-Regular.woff2");
    assertEquals((bytes?.byteLength ?? 0) > 1000, true);
    assertEquals(await checkout.getFont("KaTeX_Missing.woff2"), undefined);
    assertEquals(await checkout.getFont("../../etc/passwd"), undefined);
    assertEquals(await checkout.getFont("constructor"), undefined);

    // A packaged build: the manifest carries the bytes encoded, and it is
    // the whole authority (no repository layout to read fonts from).
    await fsp.writeFile(
      manifestPath,
      JSON.stringify({
        client: {},
        "styles.css": "",
        "favicon.png": "",
        pwaIcons: {},
        fonts: {
          "KaTeX_Main-Regular.woff2": btoa(String.fromCharCode(...font)),
        },
        "sw.js": "",
      }),
    );
    const packaged = new Assets(root, join(root, "cache"), manifestPath);
    assertEquals(await packaged.getFont("KaTeX_Main-Regular.woff2"), font);
    assertEquals(await packaged.getFont("KaTeX_Missing.woff2"), undefined);
  } finally {
    await removeDirRetry(root);
  }
});
