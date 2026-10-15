import { build } from "esbuild";
import { join } from "node:path";
import { BROWSER_CORE_ENTRIES } from "@lumisca/core/browser-entries";

export interface BundleOptions {
  /** Repository root (used as esbuild working directory for node_modules resolution). */
  cwd: string;
  entry: string;
  outfile: string;
}

/** Bundle the client entry with esbuild's JS API. */
export async function bundleClient(options: BundleOptions): Promise<void> {
  await build({
    entryPoints: [options.entry],
    absWorkingDir: options.cwd,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    outfile: options.outfile,
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
}
