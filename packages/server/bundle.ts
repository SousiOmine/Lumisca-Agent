import { build } from "esbuild";
import { coreModesPath, coreSharedPath } from "./paths.ts";

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
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    outfile: options.outfile,
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
    // The web package imports @lumisca/core/shared and @lumisca/core/modes
    // (pure helpers). esbuild does not read deno.json workspace exports, so
    // resolve the aliases here.
    alias: {
      "@lumisca/core/shared": coreSharedPath(options.cwd),
      "@lumisca/core/modes": coreModesPath(options.cwd),
    },
  });
}
