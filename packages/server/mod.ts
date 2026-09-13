import { dirname } from "node:path";
import {
  HttpBrowserBackend,
  LumiscaCore,
  refreshCatalogInBackground,
  resolveSettingsPath,
} from "@lumisca/core";
import { disposeServer, startServer, validateHostConfig } from "./app.ts";
import {
  consumeServerStartupEnvironment,
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultAssetsFile,
  describeListenError,
  DESKTOP_ENV_KEY,
  isAddressInUseError,
  isDesktopManaged,
  parsePortWaitMs,
  parseServerPort,
  parseUpdateRestartMode,
  PORT_WAIT_ENV_KEY,
  UPDATE_MANIFEST_ENV_KEY,
  UPDATE_RESTART_ENV_KEY,
  updateSupport,
} from "./startup.ts";
import { createShutdown } from "./shutdown.ts";
import { runServiceCommand } from "./systemd/mod.ts";
import { UpdateService } from "./update/service.ts";
import { SERVER_VERSION } from "./version.ts";

const DEFAULT_DB = "lumisca.db";
/** Retry cadence while waiting for an occupied port (the updater's
 * successor). */
const PORT_RETRY_INTERVAL_MS = 250;

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

// `--version` answers the updater's self-check (packages/server/update/
// install.ts runs the staged binary with it before replacing anything) and
// any "which build is this?" support question. Handled before the
// environment is consumed so it reads nothing and starts nothing.
if (Deno.args.includes("--version")) {
  console.log(SERVER_VERSION);
  Deno.exit(0);
}

/** The launcher's own command surface (the server's first argument). */
const LAUNCHER_USAGE = [
  "使い方:",
  "  lumisca-server                      サーバーを起動します",
  "  lumisca-server service <サブコマンド>  systemd ユーザーユニットを管理します",
  "",
  "詳細: lumisca-server service --help",
].join("\n");

// The launcher's own commands, handled before the environment is consumed:
// `service` installs and inspects the systemd user unit (systemd/mod.ts).
// Every other argument is a usage error — silently starting a server for a
// mistyped flag or an option meant for a subcommand would be a running
// service nobody asked for. The desktop shell spawns this binary with no
// arguments, so the strict surface costs it nothing.
const launcherCommand = Deno.args[0];
if (launcherCommand === "--help" || launcherCommand === "-h") {
  console.log(LAUNCHER_USAGE);
  Deno.exit(0);
}
if (launcherCommand !== undefined && launcherCommand !== "service") {
  console.error(`lumisca-server: 不明な引数です: ${Deno.args.join(" ")}\n`);
  console.error(LAUNCHER_USAGE);
  Deno.exit(2);
}

if (launcherCommand === "service") {
  // The exit code is the only report a script sees, and the global
  // unhandled-rejection handler above is deliberately forgiving (it exists so
  // a long-running server keeps serving). A launcher command must not inherit
  // that: an unexpected rejection here exits 1 instead of quietly reporting
  // success (the smoke test caught exactly that shape when the machine could
  // not be resolved).
  try {
    Deno.exit(await runServiceCommand(Deno.args.slice(1)));
  } catch (error) {
    console.error(
      `lumisca-server service: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}

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
// Only the updater's successor sets this: it starts before its predecessor
// has released the port (and Windows keeps TIME_WAIT sockets on it), so it
// retries the bind instead of failing a healthy machine.
const portWaitMs = parsePortWaitMs(startupEnv[PORT_WAIT_ENV_KEY]);
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

// The updater of this installation. `server` is filled in below (the
// restart path needs to release the listener before its successor starts,
// and the listener does not exist yet).
let server: Deno.HttpServer<Deno.NetAddr> | undefined;
const support = updateSupport({
  desktopManaged: isDesktopManaged(startupEnv[DESKTOP_ENV_KEY]),
  standalone: Deno.build.standalone,
});
// No updater object when this installation cannot update itself: without it
// the `/api/update/*` routes are not registered at all (see app.ts), so a
// development server answers 404 and the UI shows no update controls —
// instead of reporting an updater whose whole purpose is disabled here.
const update = support.enabled
  ? new UpdateService({
    environment: {
      installDir: dirname(Deno.execPath()),
      execPath: Deno.execPath(),
    },
    settings: core,
    // The successor must start exactly like this process did, so the launch
    // configuration captured at startup is replayed for it.
    startupEnv,
    cwd: Deno.cwd(),
    manifestUrl: startupEnv[UPDATE_MANIFEST_ENV_KEY] || undefined,
    restartMode: parseUpdateRestartMode(startupEnv[UPDATE_RESTART_ENV_KEY]),
    shutdown: async () => {
      if (server !== undefined) {
        // Stop accepting first (the successor binds the same port), then let
        // the core close its children and its database before the successor
        // opens the same database file.
        disposeServer(server);
        server.shutdown();
      }
      await core.close();
    },
  })
  : undefined;

// A taken port (usually a leftover `deno task dev:server`) must fail with
// guidance, not an `AddrInUse` stack trace. The DB is closed before exit
// so no lock files linger for the next attempt.
let listenError: unknown;
let attempts = 0;
const listenDeadline = Date.now() + portWaitMs;
for (;;) {
  attempts++;
  try {
    server = startServer(core, port, {
      repoRoot,
      assetsFile,
      token,
      hostname: host,
      allowedHosts,
      update,
    });
    break;
  } catch (error) {
    listenError = error;
    if (
      !isAddressInUseError(error) || Date.now() >= listenDeadline
    ) {
      break;
    }
    // The previous instance is still on the way out; wait for it instead of
    // starting on another port (the page's URL must stay stable).
    await new Promise((resolve) => setTimeout(resolve, PORT_RETRY_INTERVAL_MS));
  }
}
if (server === undefined) {
  console.error(
    (portWaitMs > 0 ? `(${attempts} 回試行) ` : "") +
      describeListenError(host, port, listenError),
  );
  await core.close();
  Deno.exit(1);
}

console.log(`Lumisca server listening on http://${host}:${port}`);
console.log(`Database: ${dbPath}`);
console.log(`Settings: ${settingsPath}`);
console.log(
  `Frontend assets: ${assetsFile ?? `${repoRoot} (repository sources)`}`,
);
if (update !== undefined) {
  console.log(
    `Auto-update: v${SERVER_VERSION} (${update.manifestUrl})` +
      (update.status().restartMode === "none"
        ? " — restart left to the operator (LUMISCA_UPDATE_RESTART=none)"
        : ""),
  );
} else {
  console.log(`Auto-update: disabled — ${support.reason}`);
}
if (token) console.log("Token authentication enabled");
if (allowedHosts.length > 0) {
  console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
}

// Periodic update check (absent when this installation cannot update
// itself), plus the cleanup of leftovers from a previous update.
update?.start();

// The stop contract of a supervised server (shutdown.ts): SIGTERM is
// systemd's ordinary stop request and exits 0, SIGINT reports 130, the drain
// is bounded, and a second signal skips the rest of it.
const shutdown = createShutdown({
  dispose: async () => {
    console.log("\nShutting down...");
    update?.dispose();
    disposeServer(server);
    server.shutdown();
    await core.close();
  },
  exit: (code) => Deno.exit(code),
  onSignal: (signal) => console.log(`${signal} を受信しました`),
  onError: (message) => console.error(`Lumisca: ${message}`),
});
Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
