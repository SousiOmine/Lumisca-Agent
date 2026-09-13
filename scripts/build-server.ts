/**
 * Build a packaged Lumisca server: the frontend assets a server can serve
 * (`assets.json`), Skia's ICU data file on Windows, and — unless
 * `--no-compile` — the `deno compile` binary itself.
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
 *   deno run --allow-all scripts/build-server.ts [--out <dir>] [--no-compile]
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildAssetsManifest } from "../packages/server/assets.ts";
import { binaryName, repoRoot, reportUsage } from "./lib.ts";

/**
 * Permissions embedded into the compiled server. `deno compile` bakes them
 * in (the artifact cannot ask for more at runtime); the desktop shell
 * launches the same binary, so this one list serves both distributions.
 */
const SERVER_PERMISSIONS = [
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  "--allow-ffi",
] as const;

const SERVER_ENTRY = join(repoRoot, "packages", "server", "mod.ts");

interface Options {
  /** Absolute output directory (staged package). */
  outDir: string;
  /** False with `--no-compile`: assets + placeholder only. */
  compile: boolean;
}

function usage(message?: string): never {
  reportUsage(
    "build-server",
    "deno run --allow-all scripts/build-server.ts [--out <dir>] [--no-compile]",
    message,
  );
}

/** Where a standalone server package is staged by default: one directory
 * per `deno compile` target, so several platforms can be built side by
 * side (the release workflow ships one directory to each platform). */
function defaultOutDir(): string {
  return join(repoRoot, "dist", "server", "stage", Deno.build.target);
}

function parseArgs(args: readonly string[]): Options {
  let out: string | undefined;
  let compile = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
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
  const outDir = out === undefined
    ? defaultOutDir()
    : isAbsolute(out)
    ? out
    : resolve(Deno.cwd(), out);
  return { outDir, compile };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Compile the server entry into `outputPath`. The stored `deno compile`
 * artifact must be replaced by hand first: an existing file (notably the
 * `--no-compile` placeholder) makes the compiler refuse to write. */
async function compileServer(outputPath: string): Promise<void> {
  await Deno.remove(outputPath).catch(() => {});
  const status = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      ...SERVER_PERMISSIONS,
      "--output",
      outputPath,
      SERVER_ENTRY,
    ],
    cwd: repoRoot,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    console.error(
      `build-server: deno compile failed (exit ${status.code}); ` +
        "the packaged server was not produced",
    );
    Deno.exit(status.code === 0 ? 1 : status.code);
  }
}

/**
 * Stage Skia's ICU data file next to the server binary. `deno compile` does
 * not bundle it, and @napi-rs/canvas' native Skia aborts the whole server
 * process when it is missing (see packages/core/pdf/tools.ts, which looks
 * for `icudtl.dat` beside the executable). The file is copied verbatim
 * from the installed `@napi-rs/canvas-<platform>` npm package, so its
 * embedded Unicode copyright notice is preserved (see
 * THIRD-PARTY-NOTICES.md at the repository root).
 */
async function stageCanvasIcuData(outDir: string): Promise<void> {
  const target = join(outDir, "icudtl.dat");
  if (Deno.build.os !== "windows") {
    // macOS/Linux Skia embeds its ICU data; no file to ship. Drop any
    // stale file a previous Windows run left in a shared output directory
    // (the desktop resources dir is the same directory for both platforms).
    await Deno.remove(target).catch(() => {});
    return;
  }
  const source = await findCanvasIcuDataFile(repoRoot);
  if (source === undefined) {
    console.warn(
      "WARNING: icudtl.dat not found in the installed Windows " +
        "@napi-rs/canvas packages; this build ships without PDF " +
        "rendering support (the PDF tool refuses to load Skia instead " +
        "of crashing the server).",
    );
    return;
  }
  await Deno.copyFile(source, target);
  const { size } = await Deno.stat(target);
  console.log(`ICU data: ${target} (${size} bytes, from ${source})`);
}

/**
 * npm target triple whose ICU data file this host's Skia binary expects.
 * Only the Windows packages bundle `icudtl.dat` (see the staging step
 * above).
 */
function preferredCanvasTarget(): string {
  return Deno.build.arch === "aarch64" ? "win32-arm64-msvc" : "win32-x64-msvc";
}

/**
 * Locate the Windows `icudtl.dat` inside the installed
 * `@napi-rs/canvas-<platform>` packages. Both of Deno's node_modules
 * layouts are searched (the isolated `.deno` tree and the classic flat
 * tree) without pinning a canvas version. Returns undefined when no
 * platform package is installed.
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

const options = parseArgs(Deno.args);
await Deno.mkdir(options.outDir, { recursive: true });

// 1. Bundle the client and read the static assets into the manifest.
const { manifest, appJsBytes } = await buildAssetsManifest(repoRoot);
const assetsFile = join(options.outDir, "assets.json");
await Deno.writeTextFile(assetsFile, JSON.stringify(manifest));
console.log(`Assets: ${assetsFile} (${appJsBytes} bytes of JS)`);

// 2. Stage Skia's ICU data file (Windows only; removed elsewhere).
await stageCanvasIcuData(options.outDir);

// 3. Produce the runnable server (or the placeholder a development build
//    needs for `cargo check` / `tauri dev`).
const binaryPath = join(options.outDir, binaryName());
if (options.compile) {
  await compileServer(binaryPath);
  const { size } = await Deno.stat(binaryPath);
  console.log(`Server binary: ${binaryPath} (${size} bytes)`);
} else if (await exists(binaryPath)) {
  console.log(`Placeholder binary kept at ${binaryPath} (--no-compile)`);
} else {
  await Deno.writeFile(binaryPath, new Uint8Array(0));
  console.log(`Placeholder binary written to ${binaryPath} (--no-compile)`);
}

console.log(`Staged server package: ${dirname(binaryPath)}`);
