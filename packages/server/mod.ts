import { LumiscaCore, resolveSettingsPath } from "@lumisca/core";
import { disposeServer, startServer, validateHostConfig } from "./app.ts";

const DEFAULT_HOST = "127.0.0.1";
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
 * different working directory; without it the web UI cannot be served.
 * Normalized to an absolute path — esbuild rejects relative working
 * directories when bundling the client. */
function resolveRepoRoot(): string {
  const root = Deno.env.get("LUMISCA_REPO_ROOT") ?? Deno.cwd();
  try {
    return Deno.realPathSync(root);
  } catch {
    return root;
  }
}

/** Extra hostnames accepted by the Host guard (LUMISCA_ALLOWED_HOSTS,
 * comma-separated, no port). Loopback hostnames are always accepted. */
function resolveAllowedHosts(): string[] {
  return (Deno.env.get("LUMISCA_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

// Optional auth token (the desktop shell sets one): /api, /ws and — unless
// a local dev server — the SSR page then require it, so only clients that
// know the token can drive the agent.
const token = Deno.env.get("LUMISCA_TOKEN") || undefined;

// Bind address (LUMISCA_HOST). The default is loopback-only; remote
// hosting (LAN / Tailscale) sets 0.0.0.0, a specific IP, or "::".
const host = Deno.env.get("LUMISCA_HOST") ?? DEFAULT_HOST;

// Refuse to expose the agent (bash tool included) to the network without
// authentication.
const configError = validateHostConfig(host, token);
if (configError) {
  console.error(`Lumisca: ${configError}`);
  Deno.exit(1);
}

const port = Number(Deno.env.get("LUMISCA_PORT") ?? DEFAULT_PORT);
const dbPath = resolveDbPath();
const settingsPath = resolveSettingsPath();
const repoRoot = resolveRepoRoot();
const allowedHosts = resolveAllowedHosts();

const core = LumiscaCore.open(dbPath, settingsPath);
const server = startServer(core, port, {
  repoRoot,
  token,
  hostname: host,
  allowedHosts,
});

console.log(`Lumisca server listening on http://${host}:${port}`);
console.log(`Database: ${dbPath}`);
console.log(`Settings: ${settingsPath}`);
if (token) console.log("Token authentication enabled");
if (allowedHosts.length > 0) {
  console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
}

const shutdown = () => {
  console.log("\nShutting down...");
  disposeServer(server);
  server.shutdown();
  core.close();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
