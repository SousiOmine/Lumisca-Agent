import {
  HttpBrowserBackend,
  LumiscaCore,
  refreshCatalogInBackground,
  resolveSettingsPath,
} from "@lumisca/core";
import { disposeServer, startServer, validateHostConfig } from "./app.ts";
import {
  consumeServerStartupEnvironment,
  defaultAssetsFile,
  describeListenError,
  parseServerPort,
} from "./startup.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8000;
const DEFAULT_DB = "lumisca.db";

// A fire-and-forget promise that rejects without a handler would otherwise
// terminate the whole server process (Deno exits on unhandled rejections),
// leaving the desktop WebView frozen on a dead page with no explanation.
// Log loudly and keep serving instead: the failure itself still surfaces as
// a session_error on its own session, and the desktop shell captures this
// output for copy-paste (see packages/desktop server.rs).
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const reason = (event as PromiseRejectionEvent).reason;
  console.error(
    `Lumisca: unhandled promise rejection: ${
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason)
    }`,
  );
});

// Launcher-only configuration must be consumed before LumiscaCore creates
// tools. Every command spawned afterwards inherits the cleaned environment,
// not this server instance's port, database, token, or browser endpoint.
const startupEnv = consumeServerStartupEnvironment();

function resolveDbPath(): string {
  const db = startupEnv.LUMISCA_DB;
  if (db) return db;
  const home = startupEnv.LUMISCA_HOME;
  if (home) return `${home}/lumisca.db`;
  return `${Deno.cwd()}/${DEFAULT_DB}`;
}

/** Repository root for frontend assets. The desktop shell sets
 * LUMISCA_REPO_ROOT because the server process it spawns runs from a
 * different working directory; without it the web UI cannot be served.
 * Normalized to an absolute path — esbuild rejects relative working
 * directories when bundling the client. */
function resolveRepoRoot(): string {
  const root = startupEnv.LUMISCA_REPO_ROOT ?? Deno.cwd();
  try {
    return Deno.realPathSync(root);
  } catch {
    return root;
  }
}

/** Extra hostnames accepted by the Host guard (LUMISCA_ALLOWED_HOSTS,
 * comma-separated, no port). Loopback hostnames are always accepted. */
function resolveAllowedHosts(): string[] {
  return (startupEnv.LUMISCA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Desktop mode: the shell hands the browser-lab RPC endpoint and its
 * per-run token to the server child through the environment. Attach the
 * backend when both are present — the agent then gets the browser tools.
 * A half-set pair is a shell bug: report it loudly and run WITHOUT
 * browser tools, never with a guessed endpoint. Plain server mode has no
 * environment → no browser surface at all.
 */
function attachBrowserBackend(core: LumiscaCore): void {
  const url = startupEnv.LUMISCA_BROWSER_IPC_URL;
  const token = startupEnv.LUMISCA_BROWSER_TOKEN;
  if (url === undefined && token === undefined) return;
  if (url === undefined || token === undefined) {
    console.error(
      "Lumisca: LUMISCA_BROWSER_IPC_URL と LUMISCA_BROWSER_TOKEN は" +
        "ペアで設定してください (ブラウザを無効化して続行します)",
    );
    return;
  }
  core.setBrowserBackend(new HttpBrowserBackend({ url, token }));
}

// Optional auth token (the desktop shell sets one): /api, /ws and — unless
// a local dev server — the page then require it, so only clients that
// know the token can drive the agent.
const token = startupEnv.LUMISCA_TOKEN || undefined;

// Bind address (LUMISCA_HOST). The default is loopback-only; remote
// hosting (LAN / Tailscale) sets 0.0.0.0, a specific IP, or "::".
const host = startupEnv.LUMISCA_HOST ?? DEFAULT_HOST;

// Refuse to expose the agent (bash tool included) to the network without
// authentication.
const configError = validateHostConfig(host, token);
if (configError) {
  console.error(`Lumisca: ${configError}`);
  Deno.exit(1);
}

let port: number;
try {
  port = parseServerPort(startupEnv.LUMISCA_PORT, DEFAULT_PORT);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
const dbPath = resolveDbPath();
const settingsPath = resolveSettingsPath();
const repoRoot = resolveRepoRoot();
const allowedHosts = resolveAllowedHosts();
// Explicit LUMISCA_ASSETS_FILE (the desktop shell passes the resource path)
// wins; otherwise a packaged release uses the manifest staged next to its
// own binary (scripts/build-server.ts), so it runs without configuration.
// (`||` so a blank value counts as unset, like every other startup value.)
const assetsFile = startupEnv.LUMISCA_ASSETS_FILE ||
  defaultAssetsFile(Deno.execPath());

let core: LumiscaCore;
try {
  core = LumiscaCore.open(dbPath, settingsPath);
} catch (error) {
  console.error(
    `Lumisca: データベースを開けませんでした (${dbPath}): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  Deno.exit(1);
}
attachBrowserBackend(core);
// The model catalog starts as the bundled snapshot; refresh it in the
// background so new models.dev entries appear without blocking startup
// (or failing it when offline — the snapshot simply stays active).
refreshCatalogInBackground(core);
// A taken port (usually a leftover `deno task dev:server`) must fail with
// guidance, not an `AddrInUse` stack trace. The DB is closed before exit
// so no lock files linger for the next attempt.
let server: Deno.HttpServer<Deno.NetAddr>;
try {
  server = startServer(core, port, {
    repoRoot,
    assetsFile,
    token,
    hostname: host,
    allowedHosts,
  });
} catch (error) {
  console.error(describeListenError(host, port, error));
  await core.close();
  Deno.exit(1);
}

console.log(`Lumisca server listening on http://${host}:${port}`);
console.log(`Database: ${dbPath}`);
console.log(`Settings: ${settingsPath}`);
console.log(
  `Frontend assets: ${assetsFile ?? `${repoRoot} (repository sources)`}`,
);
if (token) console.log("Token authentication enabled");
if (allowedHosts.length > 0) {
  console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
}

const shutdown = async () => {
  console.log("\nShutting down...");
  disposeServer(server);
  server.shutdown();
  await core.close();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
