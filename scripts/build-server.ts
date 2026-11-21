/**
 * Build a packaged Lumisca server: the frontend assets a server can serve
 * (`assets.json`), Skia's ICU data file on Windows, and — unless
 * `--no-compile` — the compiled binary itself.
 *
 * This is the single build path for BOTH distributions. The desktop shell
 * embeds the very same binary as a Tauri resource (`--out
 * src-tauri/resources/server` from packages/desktop) and the server-only
 * release publishes it standalone (the default `--out
 * dist/server/stage/<target>`), so the permission flags, the asset layout
 * and the ICU staging can never drift between them.
 *
 * Usage (from the repository root, or via `npm run build:server` in
 * packages/desktop):
 *
 *   bun run scripts/build-server.ts [--out <dir>] [--no-compile]
 *
 * `--no-compile` stages the assets and keeps a zero-byte placeholder binary
 * instead of compiling: `cargo check` and `tauri dev` need the resource to
 * exist, and a real binary left over from an earlier release build must not
 * be picked up by a development launch (see
 * packages/desktop/src-tauri/src/server.rs).
 *
 * The assets manifest is produced by the server's single asset owner
 * (packages/server/assets.ts), so the prebuild and the runtime can never
 * disagree about what an asset is.
 */

import * as fsp from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findCanvasIcuDataFile } from "../packages/core/pdf/icu-data.ts";
import { OS, TARGET } from "../packages/core/platform.ts";
import { exit, spawnProcess } from "../packages/core/process.ts";
import { VM_CONTAINER_DIR_NAME } from "../packages/core/vm/contract.ts";
import { buildAssetsManifest } from "../packages/server/assets.ts";
import {
  ASSETS_FILE_NAME,
  ICU_DATA_FILE_NAME,
} from "../packages/server/layout.ts";
import { renderDesktopDocument } from "../packages/server/render.ts";
import { binaryName, repoRoot, reportUsage } from "./lib.ts";

/** The entry both distributions compile: the desktop shell bundles the
 * resulting binary as a Tauri resource, the server-only release publishes it
 * on its own. */
const SERVER_ENTRY = join(repoRoot, "packages", "server", "mod.ts");

interface Options {
  /** Absolute output directory (staged package). */
  outDir: string;
  /** False with `--no-compile`: assets + placeholder only. */
  compile: boolean;
  /** Absolute directory the desktop shell's bundled UI is written to
   * (`--frontend`), or undefined for a server-only build. */
  frontendDir?: string;
}

function usage(message?: string): never {
  reportUsage(
    "build-server",
    "bun run scripts/build-server.ts [--out <dir>] [--no-compile] [--frontend <dir>]",
    message,
  );
}

/** Where a standalone server package is staged by default: one directory
 * per build target (Rust target triples, which the release manifests still
 * use), so several platforms can be built side by side. */
function defaultOutDir(): string {
  return join(repoRoot, "dist", "server", "stage", TARGET);
}

function parseArgs(args: readonly string[]): Options {
  let out: string | undefined;
  let frontend: string | undefined;
  let compile = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--frontend") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        usage("--frontend needs a directory");
      }
      frontend = value;
      i++;
    } else if (arg === "--out") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        usage("--out needs a directory");
      }
      out = value;
      i++;
    } else if (arg === "--no-compile") {
      compile = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  // A relative --out resolves against the caller's working directory (the
  // desktop build passes `src-tauri/resources/server` from packages/desktop).
  const outDir =
    out === undefined
      ? defaultOutDir()
      : isAbsolute(out)
        ? out
        : resolve(process.cwd(), out);
  const frontendDir =
    frontend === undefined
      ? undefined
      : isAbsolute(frontend)
        ? frontend
        : resolve(process.cwd(), frontend);
  return {
    outDir,
    compile,
    ...(frontendDir === undefined ? {} : { frontendDir }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write the same client build into the desktop shell's frontend directory
 * (`--frontend`). Tauri serves that directory from the app's own origin, so
 * the desktop window shows this bundle and asks the selected server only
 * for API data. One bundle function feeds both distributions, so the two
 * cannot drift.
 *
 * The assets directory is replaced, not merged: a chunk a previous build
 * wrote and this one no longer emits must not stay in the package. The
 * splash files beside it (splash.html, splash.js) are the shell's own and
 * are left alone. */
async function stageDesktopFrontend(
  frontendDir: string,
  manifest: {
    client: Record<string, { body: string }>;
    "styles.css": string;
  },
): Promise<void> {
  const assets = join(frontendDir, "assets");
  await fsp.rm(assets, { recursive: true, force: true });
  await fsp.mkdir(assets, { recursive: true });
  for (const [name, file] of Object.entries(manifest.client)) {
    await fsp.writeFile(join(assets, name), file.body);
  }
  await fsp.writeFile(join(assets, "styles.css"), manifest["styles.css"]);
  await fsp.writeFile(join(frontendDir, "index.html"), renderDesktopDocument());
  console.log(`Desktop UI: ${frontendDir}`);
}

/** Compile the server entry into `outputPath`. The stored binary must be
 * replaced by hand first: an existing file (notably the `--no-compile`
 * placeholder) makes the compiler refuse to write. */
async function compileServer(outputPath: string): Promise<void> {
  await fsp.rm(outputPath).catch(() => {});
  // Bun builds a single executable from the same entry.
  const code = await spawnProcess(
    [
      process.execPath,
      "build",
      "--compile",
      "--outfile",
      outputPath,
      SERVER_ENTRY,
    ],
    {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  ).exited;
  if (code !== 0) {
    console.error(
      `build-server: bun build --compile failed (exit ${code}); ` +
        "the packaged server was not produced",
    );
    exit(code);
  }
}

/**
 * Stage Skia's ICU data file next to the server binary. The compiled
 * executable does not carry it, and @napi-rs/canvas' native Skia aborts the whole server
 * process when it is missing (see packages/core/pdf/tools.ts, which looks
 * for `icudtl.dat` beside the executable). The file is copied verbatim
 * from the installed `@napi-rs/canvas-<platform>` npm package, so its
 * embedded Unicode copyright notice is preserved (see
 * THIRD-PARTY-NOTICES.md at the repository root).
 */
async function stageCanvasIcuData(outDir: string): Promise<void> {
  const target = join(outDir, ICU_DATA_FILE_NAME);
  if (OS !== "windows") {
    // macOS/Linux Skia embeds its ICU data; no file to ship. Drop any
    // stale file a previous Windows run left in a shared output directory
    // (the desktop resources dir is the same directory for both platforms).
    await fsp.rm(target).catch(() => {});
    return;
  }
  // The search the server itself runs at startup (packages/core/pdf/
  // icu-data.ts): the build stages exactly the file the runtime picks.
  const source = findCanvasIcuDataFile();
  if (source === undefined) {
    console.warn(
      "WARNING: icudtl.dat not found in the installed Windows " +
        "@napi-rs/canvas packages; this build ships without PDF " +
        "rendering support (the PDF tool refuses to load Skia instead " +
        "of crashing the server).",
    );
    return;
  }
  await fsp.copyFile(source, target);
  const { size } = await fsp.stat(target);
  console.log(`ICU data: ${target} (${size} bytes, from ${source})`);
}

/**
 * Stage the stella machine's container files beside the binary.
 *
 * A compiled server cannot read them any other way: `bun build --compile`
 * produces a single executable with no file system of its own, and the server runs
 * `podman build` against a Containerfile on disk. The directory name is the
 * one packages/server/paths.ts looks for (`VM_CONTAINER_DIR_NAME`), so the
 * runtime and the packaging cannot disagree.
 */
async function stageStellaContainer(outDir: string): Promise<void> {
  const source = join(repoRoot, "packages", "core", "vm", "container");
  const target = join(outDir, VM_CONTAINER_DIR_NAME);
  await fsp.rm(target, { recursive: true }).catch(() => {});
  await copyContainerTree(source, target);
  console.log(`stella container files: ${target}`);
}

/**
 * Copy the container definition beside the binary.
 *
 * The whole tree is copied, subdirectories included: the Containerfile names
 * its inputs by relative path, so a flattened copy would build an image whose
 * `COPY` finds nothing. The files themselves sit flat today (the package
 * layout a running server can read is one directory deep); the walk stays
 * recursive so that fact is not a hidden assumption of this function.
 */
async function copyContainerTree(
  source: string,
  target: string,
): Promise<void> {
  await fsp.mkdir(target, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyContainerTree(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    await fsp.copyFile(from, to);
    // entry.sh must stay executable: podman runs it as the container's CMD,
    // and a copied mode is not guaranteed by every platform's filesystem.
    if (entry.name.endsWith(".sh")) {
      await fsp.chmod(to, 0o755).catch(() => {});
    }
  }
}

const options = parseArgs(process.argv.slice(2));
await fsp.mkdir(options.outDir, { recursive: true });

// 1. Bundle the client and read the static assets into the manifest. The
//    client's chunks travel inside `assets.json`, so a package stays the
//    binary, this one file, and the ICU/container data — nothing else to
//    stage, and no directory whose contents could go stale.
const { manifest, clientBytes } = await buildAssetsManifest(repoRoot);
const assetsFile = join(options.outDir, ASSETS_FILE_NAME);
await fsp.writeFile(assetsFile, JSON.stringify(manifest));
console.log(
  `Assets: ${assetsFile} (${clientBytes} bytes of JS: ` +
    `${Object.keys(manifest.client).join(", ")})`,
);
if (options.frontendDir !== undefined) {
  await stageDesktopFrontend(options.frontendDir, manifest);
}

// 2. Stage Skia's ICU data file (Windows only; removed elsewhere), and the
//    stella machine's container files (used by `podman build` at runtime).
await stageCanvasIcuData(options.outDir);
await stageStellaContainer(options.outDir);

// 3. Produce the runnable server (or the placeholder a development build
//    needs for `cargo check` / `tauri dev`).
const binaryPath = join(options.outDir, binaryName());
if (options.compile) {
  await compileServer(binaryPath);
  const { size } = await fsp.stat(binaryPath);
  console.log(`Server binary: ${binaryPath} (${size} bytes)`);
} else if (await exists(binaryPath)) {
  console.log(`Placeholder binary kept at ${binaryPath} (--no-compile)`);
} else {
  await fsp.writeFile(binaryPath, new Uint8Array(0));
  console.log(`Placeholder binary written to ${binaryPath} (--no-compile)`);
}

console.log(`Staged server package: ${dirname(binaryPath)}`);
