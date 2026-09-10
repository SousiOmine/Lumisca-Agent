/**
 * Generate `packages/desktop/src-tauri/resources/server/assets.json` with
 * the frontend assets baked in, so a packaged server (deno compile) can
 * serve the UI without the repository layout.
 *
 * Also stages Skia's ICU data file (`icudtl.dat`) next to the server
 * binary. The PDF page-image tool renders through @napi-rs/canvas, whose
 * native Skia library aborts the whole server process when the ICU data
 * file is missing (see packages/core/pdf/tools.ts); `deno compile` does
 * not bundle it, so it ships as the `server/icudtl.dat` Tauri resource
 * instead. The file is copied verbatim from the installed
 * `@napi-rs/canvas-<platform>` npm package, so its embedded Unicode
 * copyright notice is preserved (see THIRD-PARTY-NOTICES.md at the
 * repository root).
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

// 3. Stage Skia's ICU data file for the `server/icudtl.dat` resource.
// Each release runner copies its own platform's file, so every installer
// carries the data its Skia binary expects.
const icuSource = await findCanvasIcuDataFile(repoRoot);
if (icuSource === undefined) {
  console.warn(
    "WARNING: icudtl.dat not found in the installed @napi-rs/canvas " +
      "packages; the desktop build ships without PDF rendering support " +
      "(the PDF tool refuses to load Skia instead of crashing the server).",
  );
} else {
  const icuOut = join(outDir, "icudtl.dat");
  await Deno.copyFile(icuSource, icuOut);
  const { size } = await Deno.stat(icuOut);
  console.log(
    `ICU data staged at ${icuOut} (${size} bytes, from ${icuSource})`,
  );
}

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
// The ICU data slot exists for the same reason (Tauri validates every
// declared bundle resource at config-parse time), but a missing file must
// stay missing: an empty icudtl.dat would satisfy the validator while
// breaking Skia at runtime in a harder-to-diagnose way, so only a real
// staged file is ever written.
if (icuSource === undefined) {
  try {
    await Deno.remove(join(outDir, "icudtl.dat"));
  } catch {
    // No stale file to clean; nothing to do.
  }
}

console.log(
  `Embedded assets written to ${outFile} (${appJsBytes} bytes of JS)`,
);

/** npm target triple whose ICU data file this host's Skia binary expects. */
function preferredCanvasTarget(): string {
  const { os, arch } = Deno.build;
  if (os === "windows") {
    return arch === "aarch64" ? "win32-arm64-msvc" : "win32-x64-msvc";
  }
  if (os === "darwin") {
    return arch === "aarch64" ? "darwin-arm64" : "darwin-x64";
  }
  return arch === "aarch64" ? "linux-arm64-gnu" : "linux-x64-gnu";
}

/**
 * Locate `icudtl.dat` inside the installed `@napi-rs/canvas-<platform>`
 * packages. Both of Deno's node_modules layouts are searched (the
 * isolated `.deno` tree and the classic flat tree) without pinning a
 * canvas version. Returns undefined when no platform package is
 * installed.
 */
async function findCanvasIcuDataFile(
  root: string,
): Promise<string | undefined> {
  const found: string[] = [];
  const collectFromScope = async (scopeDir: string): Promise<void> => {
    try {
      for await (const pkg of Deno.readDir(scopeDir)) {
        if (!pkg.isDirectory || !pkg.name.startsWith("canvas-")) continue;
        const candidate = join(scopeDir, pkg.name, "icudtl.dat");
        try {
          if (
            (await Deno.stat(candidate)).isFile && !found.includes(candidate)
          ) {
            found.push(candidate);
          }
        } catch {
          // No data file in this package; keep looking.
        }
      }
    } catch {
      // No scope directory here; keep looking.
    }
  };
  // Deno's isolated layout:
  // node_modules/.deno/@napi-rs+canvas-<target>@<v>/node_modules/@napi-rs/canvas-<target>/icudtl.dat
  try {
    for await (
      const entry of Deno.readDir(join(root, "node_modules", ".deno"))
    ) {
      if (
        !entry.isDirectory || !entry.name.startsWith("@napi-rs+canvas-")
      ) continue;
      await collectFromScope(
        join(
          root,
          "node_modules",
          ".deno",
          entry.name,
          "node_modules",
          "@napi-rs",
        ),
      );
    }
  } catch {
    // No .deno directory; the flat layout below may still match.
  }
  // Classic flat layout: node_modules/@napi-rs/canvas-<target>/icudtl.dat
  await collectFromScope(join(root, "node_modules", "@napi-rs"));
  if (found.length === 0) return undefined;
  found.sort();
  const preferred = preferredCanvasTarget();
  return found.find((path) => path.includes(preferred)) ?? found[0];
}
