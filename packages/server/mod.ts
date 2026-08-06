import { LumiscaCore } from "@lumisca/core";
import { startServer } from "./app.ts";

const DEFAULT_PORT = 8000;
const DEFAULT_DB = "lumisca.db";

function resolveDbPath(): string {
  const env = Deno.env.get("LUMISCA_DB");
  if (env) return env;
  const home = Deno.env.get("LUMISCA_HOME");
  if (home) return `${home}/lumisca.db`;
  return `${Deno.cwd()}/${DEFAULT_DB}`;
}

const port = Number(Deno.env.get("LUMISCA_PORT") ?? DEFAULT_PORT);
const dbPath = resolveDbPath();

const core = LumiscaCore.open(dbPath);
const server = startServer(core, port);

console.log(`Lumisca server listening on http://127.0.0.1:${port}`);
console.log(`Database: ${dbPath}`);

Deno.addSignalListener("SIGINT", () => {
  console.log("\nShutting down...");
  server.shutdown();
  core.close();
  Deno.exit(0);
});
