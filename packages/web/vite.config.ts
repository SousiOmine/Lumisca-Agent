import { join } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
// Relative on purpose: this file is loaded by Vite (not by Bun), which does
// not resolve the workspace's `@lumisca/core/...` exports.
import { BROWSER_CORE_ENTRIES } from "../core/browser-entries.ts";
import { shellHeadTags } from "../core/shared/shell-head.ts";
import { THEME_COLORS } from "../core/shared/theme-colors.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

import { DEFAULT_PORT } from "../server/default-port.ts";

const apiTarget = `http://127.0.0.1:${DEFAULT_PORT}`;

export default defineConfig({
  plugins: [
    preact(),
    // The dev page's head comes from the same function the server uses
    // (packages/core/shared/shell-head.ts), so a tag cannot be added to one
    // shell and forgotten in the other.
    {
      name: "shell-head",
      transformIndexHtml: (html: string) =>
        html.replace(
          "<!-- shell-head -->",
          shellHeadTags({ themeColor: THEME_COLORS.dark }),
        ),
    },
  ],
  resolve: {
    // The core's browser-safe entry points, from the single list the core
    // declares (packages/core/browser-entries.ts — the boundary test and the
    // server's esbuild aliases read it too).
    alias: Object.fromEntries(
      BROWSER_CORE_ENTRIES.map((entry) => [
        entry.specifier,
        join(repoRoot, entry.path),
      ]),
    ),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/assets/initial-data.js": {
        target: apiTarget,
        changeOrigin: true,
      },
      // The manifest is generated per request by the app server (theme and
      // language come from its settings), so the dev page asks the same
      // server for it: the two shells reference the same URL.
      "/manifest.webmanifest": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: apiTarget,
        changeOrigin: true,
        rewriteWsOrigin: true,
        ws: true,
      },
    },
  },
});
