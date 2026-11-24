import { join, relative, resolve } from "node:path";
import { BROWSER_CORE_ENTRIES } from "@lumisca/core/browser-entries";
import { build } from "esbuild";

export interface BundleOptions {
  /** Repository root (used as esbuild working directory for node_modules resolution). */
  cwd: string;
  /** The app's entry. */
  entry: string;
  /** The entry that applies this client's stored theme before the first
   * paint. Built separately, without splitting, so the document can load it
   * as a classic script in the head. */
  themeEntry: string;
  /** Directory the entry chunks and the chunks they import are written to. */
  outdir: string;
}

/** What one build produced: the file the page loads and the chunks it may
 * fetch later. */
export interface BundleResult {
  /** The entry chunk's file name (`app.js` — the file render.ts loads). */
  entry: string;
  /** The theme chunk's file name (`theme.js`), loaded before the stylesheet
   * so the first frame is already in the stored theme. */
  themeEntry: string;
  /** Every file the build wrote, both entries included: the set a server has
   * to serve for this build. */
  files: string[];
}

/** Entry chunk name without its extension. esbuild appends `.js`, and the
 * page's script tag (render.ts) names the result, so it must stay stable
 * across builds — the chunks get a content hash instead. */
const ENTRY_CHUNK = "app";

/** The theme script's name. It is a classic script loaded from the head, so
 * it must not carry a content hash the document cannot know. */
const THEME_CHUNK = "theme";

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
  const common = {
    absWorkingDir: options.cwd,
    bundle: true,
    minify: true,
    platform: "browser" as const,
    outdir: options.outdir,
    // The metafile is the list of what this build wrote: reading the output
    // directory instead would also pick up a chunk a previous build left
    // there and name a file the client can no longer reach.
    metafile: true,
    logLevel: "warning" as const,
    define: { "process.env.NODE_ENV": '"production"' },
    // The web package imports the core's browser-safe helpers
    // (`@lumisca/core/shared` and friends); esbuild does not read the
    // workspace's tsconfig paths, so resolve them from the list the core
    // declares
    // (packages/core/browser-entries.ts) — the same list the web boundary
    // test and the web aliases read.
    alias: Object.fromEntries(
      BROWSER_CORE_ENTRIES.map((entry) => [
        entry.specifier,
        join(options.cwd, entry.path),
      ]),
    ),
  };

  const result = await build({
    ...common,
    entryPoints: { [ENTRY_CHUNK]: options.entry },
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "preact",
    splitting: true,
  });

  // The theme script is a classic script, not a module: it has to run before
  // the stylesheet in the head, not after the document is parsed. A second
  // build keeps it free of the chunk imports splitting would add when the app
  // entry also imports theme.ts.
  const theme = await build({
    ...common,
    entryPoints: { theme: options.themeEntry },
    format: "iife",
    splitting: false,
  });

  // Output paths are relative to `absWorkingDir`; the names a server serves
  // are relative to `outdir` (both are absolute paths to esbuild, but a
  // caller may pass `outdir` relative to the process's cwd).
  const names = (outputs: Record<string, unknown>) =>
    Object.keys(outputs).map((path) =>
      relative(resolve(options.outdir), resolve(options.cwd, path)),
    );
  return {
    entry: `${ENTRY_CHUNK}.js`,
    themeEntry: `${THEME_CHUNK}.js`,
    files: [
      ...names(result.metafile!.outputs),
      ...names(theme.metafile!.outputs),
    ],
  };
}
