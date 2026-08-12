/**
 * Generate `packages/desktop/src-tauri/resources/server/assets.json` with
 * the frontend assets baked in, so a packaged server (deno compile) can
 * serve the UI without the repository layout.
 *
 * Run before `deno compile` (npm run build:server in packages/desktop).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleClient } from "../packages/server/bundle.ts";
import {
  webClientEntry,
  webFaviconPath,
  webStylesPath,
} from "../packages/server/paths.ts";

// This script lives in scripts/; the repo root is one level up.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const outDir = join(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "resources",
  "server",
);
const outFile = join(outDir, "assets.json");

// 1. Bundle the client (same settings the dev server uses).
const tmpBundle = join(
  Deno.env.get("TMPDIR") ?? Deno.env.get("TEMP") ?? "/tmp",
  `lumisca-app-${crypto.randomUUID()}.js`,
);
await bundleClient({
  cwd: repoRoot,
  entry: webClientEntry(repoRoot),
  outfile: tmpBundle,
});
const appJs = await Deno.readTextFile(tmpBundle);
await Deno.remove(tmpBundle).catch(() => {});

// 2. Read the static assets. The favicon is binary, so it is base64-encoded
// for the JSON manifest (the server decodes it back at runtime). Chunked so
// any icon size stays within the call-stack limits of spread + String.fromCharCode.
const css = await Deno.readTextFile(webStylesPath(repoRoot));
const faviconBytes = await Deno.readFile(webFaviconPath(repoRoot));
let faviconB64 = "";
for (let i = 0; i < faviconBytes.length; i += 0x8000) {
  faviconB64 += btoa(
    String.fromCharCode(...faviconBytes.subarray(i, i + 0x8000)),
  );
}

// 3. Write the JSON manifest.
await Deno.mkdir(outDir, { recursive: true });
await Deno.writeTextFile(
  outFile,
  JSON.stringify({
    "app.js": appJs,
    "styles.css": css,
    "favicon.png": faviconB64,
  }),
);

// 4. Ensure the server binary slot exists. `tauri build` overwrites it with
// the deno-compiled server (npm run build:server); development builds and
// cargo check only need the file to exist (lib.rs falls back to the
// repository layout in dev).
const exePath = join(
  outDir,
  Deno.build.os === "windows" ? "lumisca-server.exe" : "lumisca-server",
);
try {
  await Deno.stat(exePath);
} catch {
  await Deno.writeFile(exePath, new Uint8Array(0));
}

console.log(
  `Embedded assets written to ${outFile} (${appJs.length} bytes of JS)`,
);
