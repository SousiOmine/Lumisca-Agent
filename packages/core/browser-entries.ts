/**
 * The `@lumisca/core` entry points a browser bundle may import at runtime:
 * the front-end-safe helper modules. Everything else the core offers reaches
 * the browser as types, which the bundler erases (see ARCHITECTURE.md 1).
 *
 * The list lives here — beside the modules it names — because three
 * consumers have to agree on it and none of them can read the workspace
 * exports in `deno.json`: the web package's boundary test, Vite's dev-server
 * aliases, and the server's esbuild aliases. `path` is relative to the
 * repository root; each consumer resolves it against its own root.
 *
 * Adding an entry means the module is browser-safe (no `node:` imports, no
 * Deno APIs beyond what the browser has): the boundary test, the dev server
 * and the production bundle all read this one list, so a wrong entry breaks
 * all three rather than drifting apart.
 */
export const BROWSER_CORE_ENTRIES: readonly {
  /** The specifier the web package writes in its imports. */
  specifier: string;
  /** Where that specifier resolves inside this repository. */
  path: string;
}[] = [
  { specifier: "@lumisca/core/shared", path: "packages/core/shared/mod.ts" },
  { specifier: "@lumisca/core/modes", path: "packages/core/modes/mod.ts" },
  {
    specifier: "@lumisca/core/skills/slash",
    path: "packages/core/skills/slash.ts",
  },
];
