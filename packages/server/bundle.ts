import { build } from "esbuild";
import { join, relative, resolve } from "node:path";
import { BROWSER_CORE_ENTRIES } from "@lumisca/core/browser-entries";

export interface BundleOptions {
  /** Repository root (used as esbuild working directory for node_modules resolution). */
  cwd: string;
  entry: string;
  /** Directory the entry chunk and the chunks it imports are written to. */
  outdir: string;
}

/** What one build produced: the file the page loads and the chunks it may
 * fetch later. */
export interface BundleResult {
  /** The entry chunk's file name (`app.js` — the file render.ts loads). */
  entry: string;
  /** Every file the build wrote, the entry included: the set a server has to
   * serve for this build. */
  files: string[];
}

/** Entry chunk name without its extension. esbuild appends `.js`, and the
 * page's script tag (render.ts) names the result, so it must stay stable
 * across builds — the chunks get a content hash instead. */
const ENTRY_CHUNK = "app";

/** Bundle the client entry with esbuild's JS API.
 *
 * `splitting` keeps a dynamic import out of the entry: `@novnc/novnc` (the
 * stella screen, ~188 KB) and `motion/mini` become their own files that the
 * client fetches when it actually needs them, so a reader who never opens the
 * stella screen never downloads the VNC stack. That is why the output is a
 * directory and not a single file. */
export async function bundleClient(
  options: BundleOptions,
): Promise<BundleResult> {
  const result = await build({
    entryPoints: { [ENTRY_CHUNK]: options.entry },
    absWorkingDir: options.cwd,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    outdir: options.outdir,
    splitting: true,
    // The metafile is the list of what this build wrote: reading the output
    // directory instead would also pick up a chunk a previous build left
    // there and name a file the client can no longer reach.
    metafile: true,
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
    // The web package imports the core's browser-safe helpers
    // (`@lumisca/core/shared` and friends); esbuild does not read deno.json
    // workspace exports, so resolve them from the list the core declares
    // (packages/core/browser-entries.ts) — the same list the web boundary
    // test and Vite's dev aliases read.
    alias: Object.fromEntries(
      BROWSER_CORE_ENTRIES.map((entry) => [
        entry.specifier,
        join(options.cwd, entry.path),
      ]),
    ),
  });
  // Output paths are relative to `absWorkingDir`; the names a server serves
  // are relative to `outdir` (both are absolute paths to esbuild, but a
  // caller may pass `outdir` relative to the process's cwd).
  return {
    entry: `${ENTRY_CHUNK}.js`,
    files: Object.keys(result.metafile.outputs).map((path) =>
      relative(resolve(options.outdir), resolve(options.cwd, path))
    ),
  };
}
