/**
 * Locating Skia's ICU data file (`icudtl.dat`) without loading Skia.
 *
 * Windows-only concern: the Windows Skia binaries load the data file, while
 * macOS/Linux binaries embed it. The lookup must stay load-free — merely
 * importing the platform package would initialize Skia and abort the
 * process when the file is missing, which no try/catch can contain.
 *
 * Kept apart from the PDF tool (pdf/tools.ts) so the packaging script can
 * run the exact search the server will run at startup, without pulling the
 * renderer (unpdf) into a build: `scripts/build-server.ts` stages the file
 * this module finds, so the build and the runtime cannot disagree about
 * which one that is.
 */
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { type EnvReader, processEnv } from "../models/custom.ts";

/** Platform suffixes of the `@napi-rs/canvas-<platform>` npm packages
 * (the optionalDependencies of @napi-rs/canvas plus the extra branches of
 * its js-binding loader). Probed with require.resolve only — resolving a
 * path never executes the native binding. */
const CANVAS_PLATFORM_SUFFIXES: readonly string[] = [
  "win32-x64-msvc",
  "win32-x64-gnu",
  "win32-ia32-msvc",
  "win32-arm64-msvc",
  "darwin-x64",
  "darwin-arm64",
  "darwin-universal",
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-arm-gnueabihf",
  "linux-riscv64-gnu",
  "android-arm64",
  "android-arm-eabi",
  "freebsd-x64",
  "freebsd-arm64",
];

/**
 * Locate Skia's ICU data file (`icudtl.dat`) without loading Skia itself.
 *
 * Order: (1) explicit `LUMISCA_ICU_DATA` override, (2) the `server/`
 * resource directory shipped by the desktop installer (next to the
 * deno-compiled binary), (3) next to an already-loaded canvas native
 * binding, (4) next to any installed `@napi-rs/canvas-<platform>`
 * package, resolved without loading it.
 *
 * `env` is a parameter, not a direct `Deno.env` read: the process
 * environment is shared by every test file the runner executes in
 * parallel, so a test that needs an override passes one instead of
 * mutating the real environment.
 */
export function findCanvasIcuDataFile(
  env: EnvReader = processEnv,
): string | undefined {
  const override = readOverride(env);
  if (override) {
    try {
      if (Deno.statSync(override).isFile) return override;
    } catch {
      // A stale override must not crash the process; fall through to the
      // normal search, which refuses cleanly when nothing is found.
    }
  }
  for (const dir of canvasIcuSearchDirs()) {
    const candidate = join(dir, "icudtl.dat");
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  return undefined;
}

/** The explicit override, or undefined — including when the process runs
 * without `--allow-env` (the search below still works). */
function readOverride(env: EnvReader): string | undefined {
  try {
    return env()["LUMISCA_ICU_DATA"]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function canvasIcuSearchDirs(): string[] {
  const dirs: string[] = [];
  // The deno-compiled server ships icudtl.dat next to its own binary
  // (the `server/icudtl.dat` Tauri resource).
  try {
    dirs.push(dirname(Deno.execPath()));
  } catch {
    // execPath unavailable; the searches below may still match.
  }
  try {
    const bindingRequire = createRequire(
      import.meta.resolve("@napi-rs/canvas/js-binding.js"),
    );
    // Next to an already-loaded native binding (require.cache exposes
    // the `.node` path once @napi-rs/canvas was imported earlier).
    const cache = (bindingRequire as unknown as {
      cache?: Record<string, unknown>;
    }).cache;
    if (cache) {
      for (const path of Object.keys(cache)) {
        if (path.endsWith(".node")) dirs.push(dirname(path));
      }
    }
    // Next to any installed platform package. require.resolve only
    // resolves the path — it never executes the native binding, so this
    // stays safe even when the data file is missing.
    for (const suffix of CANVAS_PLATFORM_SUFFIXES) {
      try {
        dirs.push(
          dirname(
            bindingRequire.resolve(`@napi-rs/canvas-${suffix}/package.json`),
          ),
        );
      } catch {
        // That platform's package is not installed; keep looking.
      }
    }
  } catch {
    // node resolution unavailable; fall through with what we have.
  }
  return [...new Set(dirs)];
}
