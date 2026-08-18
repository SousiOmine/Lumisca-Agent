/**
 * Generate `packages/desktop/src-tauri/resources/server/assets.json` with
 * the frontend assets baked in, so a packaged server (deno compile) can
 * serve the UI without the repository layout.
 *
 * Run before `deno compile` (npm run build:server in packages/desktop).
 *
 * The manifest is produced by the server's single asset owner
 * (packages/server/assets.ts), so the prebuild and the runtime can never
 * disagree about what an asset is.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetsManifest } from "../packages/server/assets.ts";

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

// 1. Bundle the client and read the static assets into the manifest.
const { manifest, appJsBytes } = await buildAssetsManifest(repoRoot);

// 2. Write the JSON manifest.
await Deno.mkdir(outDir, { recursive: true });
await Deno.writeTextFile(outFile, JSON.stringify(manifest));

// 3. Ensure the server binary slot exists. `tauri build` overwrites it with
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
  `Embedded assets written to ${outFile} (${appJsBytes} bytes of JS)`,
);
