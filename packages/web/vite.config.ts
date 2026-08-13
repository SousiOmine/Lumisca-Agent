import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const apiTarget = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@lumisca/core/shared": fileURLToPath(
        new URL("../core/shared.ts", import.meta.url),
      ),
      "@lumisca/core/modes": fileURLToPath(
        new URL("../core/modes/mod.ts", import.meta.url),
      ),
    },
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
