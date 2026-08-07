import { LumiscaCore } from "@lumisca/core";
import { disposeServer, startServer } from "./app.ts";

const DEFAULT_PORT = 8000;
const DEFAULT_DB = "lumisca.db";

function resolveDbPath(): string {
  const env = Deno.env.get("LUMISCA_DB");
  if (env) return env;
  const home = Deno.env.get("LUMISCA_HOME");
  if (home) return `${home}/lumisca.db`;
  return `${Deno.cwd()}/${DEFAULT_DB}`;
}

/** Repository root for frontend assets. The desktop shell sets
 * LUMISCA_REPO_ROOT because the server process it spawns runs from a
 * different working directory; without it the web UI cannot be served. */
function resolveRepoRoot(): string {
  return Deno.env.get("LUMISCA_REPO_ROOT") ?? Deno.cwd();
}

const port = Number(Deno.env.get("LUMISCA_PORT") ?? DEFAULT_PORT);
const dbPath = resolveDbPath();
const repoRoot = resolveRepoRoot();
// Optional auth token (the desktop shell sets one): /api and /ws then
// require it, so only the process that spawned this server can drive it.
const token = Deno.env.get("LUMISCA_TOKEN") || undefined;

const core = LumiscaCore.open(dbPath);
const server = startServer(core, port, { repoRoot, token });

console.log(`Lumisca server listening on http://127.0.0.1:${port}`);
console.log(`Database: ${dbPath}`);

const shutdown = () => {
  console.log("\nShutting down...");
  disposeServer(server);
  server.shutdown();
  core.close();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
