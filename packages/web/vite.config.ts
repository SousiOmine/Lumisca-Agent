import { fileURLToPath } from "node:url";
import { join } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
// Relative on purpose: this file is loaded by Vite (not by Deno), which does
// not resolve the workspace's `@lumisca/core/...` exports.
import { BROWSER_CORE_ENTRIES } from "../core/browser-entries.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const apiTarget = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [preact()],
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
      "/ws": {
        target: apiTarget,
        changeOrigin: true,
        rewriteWsOrigin: true,
        ws: true,
      },
    },
  },
});
