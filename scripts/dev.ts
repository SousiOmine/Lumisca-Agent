/**
 * Run the server with the client rebuilt from repository sources.
 *
 * The server is the product: it owns the API, the sessions and the client
 * bundle (packages/server/assets.ts builds it with esbuild on demand). There
 * is no second bundler. This script only starts that server in reload mode
 * and, when a file under packages/web/src changes, asks it to forget the
 * cached bundle; the page polls /api/build and reloads itself.
 */
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, spawnProcess } from "../packages/core/process.ts";
import { DEFAULT_PORT } from "../packages/server/default-port.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webSource = join(repoRoot, "packages", "web", "src");
const port = Number(process.env.LUMISCA_PORT ?? DEFAULT_PORT);
const reloadUrl = `http://127.0.0.1:${port}/api/dev/rebuild`;

const server = spawnProcess(
  [process.execPath, "run", "packages/server/mod.ts"],
  {
    cwd: repoRoot,
    env: { ...process.env, LUMISCA_DEV_RELOAD: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

/** The newest modification time under one directory, for the source tree
 * the client is built from. */
async function newest(dir: string): Promise<number> {
  let latest = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await newest(path));
      continue;
    }
    if (!/\.(ts|tsx|css|html)$/.test(entry.name)) continue;
    const stat = await fsp.stat(path);
    latest = Math.max(latest, stat.mtimeMs);
  }
  return latest;
}

let seen = 0;
let stopped = false;
const timer = setInterval(() => {
  void (async () => {
    if (stopped) return;
    let latest: number;
    try {
      latest = await newest(webSource);
    } catch {
      return;
    }
    if (latest <= seen) return;
    seen = latest;
    try {
      const response = await fetch(reloadUrl, { method: "POST" });
      if (!response.ok) seen = 0;
    } catch {
      // The server is starting or restarting; the next change retries.
      seen = 0;
    }
  })();
}, 700);

function stop(code: number): void {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  try {
    server.kill();
  } catch {
    // Already exited.
  }
  exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
void server.exited.then((code) => stop(code));
