import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { Assets, type AssetsManifest } from "./assets.ts";

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
    await Deno.remove(root, { recursive: true });
  }
});
