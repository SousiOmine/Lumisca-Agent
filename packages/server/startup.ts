import { dirname, join } from "node:path";
import { errorMessage } from "@lumisca/core";
import type { ServerStartupEnvironment } from "./startup-env.ts";

export type {
  EnvironmentSource,
  ServerStartupEnvironment,
} from "./startup-env.ts";
// The environment allow-list lives apart from this module so launchers
// outside the workspace (packages/desktop) can reach it without the root
// import map. Re-exported here to keep `startup.ts` the single import site.
export {
  consumeServerStartupEnvironment,
  DESKTOP_ENV_KEY,
  PORT_WAIT_ENV_KEY,
  SERVER_STARTUP_ENV_KEYS,
  UPDATE_MANIFEST_ENV_KEY,
  UPDATE_RESTART_ENV_KEY,
} from "./startup-env.ts";

/** Default bind address: loopback only. Exposing the server is an explicit
 * decision — LUMISCA_HOST plus the authorities clients will use
 * (LUMISCA_ALLOWED_HOSTS) and a token — and `service install --host` is the
 * documented way to make it (packages/server/systemd/). */
export const DEFAULT_HOST = "127.0.0.1";

/** Default port. Shared by the launcher and the service command's `--port`. */
export const DEFAULT_PORT = 8000;

/** True when the value is a usable TCP port (1〜65535). The range lives
 * here once: the launcher's LUMISCA_PORT, the service command's flags and
 * the service.env document all accept exactly these values. */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Parse a TCP port value (1〜65535). Throws with a human-readable message;
 * shared by the launcher's LUMISCA_PORT and the service command's `--port`. */
export function parsePortValue(raw: string): number {
  const port = Number(raw.trim());
  if (!isValidPort(port)) {
    throw new Error(
      `LUMISCA_PORT が不正です: "${raw}" (1〜65535 の整数を指定してください)`,
    );
  }
  return port;
}

/** Parse LUMISCA_PORT into a valid TCP port. Empty/unset → `fallback`.
 * Throws with a human-readable message for non-integers and out-of-range
 * values (the caller reports it and exits before touching the database). */
export function parseServerPort(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  return parsePortValue(raw);
}

/** The database file: LUMISCA_DB, else LUMISCA_HOME/lumisca.db, else the
 * working directory. */
export function resolveDbPath(
  env: ServerStartupEnvironment,
  cwd: string = Deno.cwd(),
): string {
  const db = env.LUMISCA_DB;
  if (db) return db;
  const home = env.LUMISCA_HOME;
  if (home) return `${home}/lumisca.db`;
  return `${cwd}/lumisca.db`;
}

/** Repository root for the frontend sources (LUMISCA_REPO_ROOT, else the
 * working directory), normalized: esbuild rejects relative working
 * directories when bundling the client. */
export function resolveRepoRoot(
  env: ServerStartupEnvironment,
  cwd: string = Deno.cwd(),
): string {
  const root = env.LUMISCA_REPO_ROOT ?? cwd;
  try {
    return Deno.realPathSync(root);
  } catch {
    return root;
  }
}

/** Extra hostnames the Host guard accepts (LUMISCA_ALLOWED_HOSTS,
 * comma-separated, no port). Loopback hostnames are always accepted. */
export function resolveAllowedHosts(env: ServerStartupEnvironment): string[] {
  return (env.LUMISCA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** True when a listen failure means "someone else holds this port". */
export function isAddressInUseError(error: unknown): boolean {
  return (
    error instanceof Deno.errors.AddrInUse ||
    (error instanceof Error && error.name === "AddrInUse")
  );
}

/** True when the value of a boolean startup flag ("1"/"true") is set. */
function isEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** True when the desktop shell owns this process (it passes the key to the
 * server child it spawns). */
export function isDesktopManaged(raw: string | undefined): boolean {
  return isEnabled(raw);
}

/** Whether this process may replace its own files (the server updater).
 *
 * Only a packaged server (`deno compile`, i.e. Deno.build.standalone) owns
 * its installation: a `bun run server` server is the repository, and the desktop
 * shell's copy lives inside the app bundle, which the shell's own updater
 * replaces (it marks the child with {@link DESKTOP_ENV_KEY}).
 *
 * The single home of that decision: the composition root builds the updater
 * from this answer (and registers no update endpoints when it is disabled),
 * so the reasoning cannot drift from the wiring.
 *
 * `standalone` is a parameter rather than a direct Deno.build read so the
 * decision stays testable.
 */
export function updateSupport(options: {
  desktopManaged: boolean;
  standalone: boolean;
}): { enabled: boolean; reason?: string } {
  if (options.desktopManaged) {
    return {
      enabled: false,
      reason: "デスクトップアプリの管理下では、アプリ側の更新機能を使います",
    };
  }
  if (!options.standalone) {
    return {
      enabled: false,
      reason:
        "開発実行 (bun run server) では自動アップデートを利用できません。パッケージ済みサーバーでのみ有効です",
    };
  }
  return { enabled: true };
}

/** How long the server retries binding its port before giving up. Only the
 * updater's successor sets this: everyone else keeps failing fast on an
 * occupied port, with the guidance of `describeListenError`. */
export function parsePortWaitMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return 0;
  return Math.min(value, 5 * 60 * 1000);
}

/** How an applied update is activated; an unrecognized value keeps the
 * default (restart in place) rather than silently never restarting. */
export type UpdateRestartMode = "self" | "supervisor" | "none";

export function parseUpdateRestartMode(
  raw: string | undefined,
): UpdateRestartMode {
  const value = raw?.trim().toLowerCase();
  if (value === "none") return "none";
  if (value === "supervisor") return "supervisor";
  return "self";
}

/** True when `path` is an existing file (a missing or unreadable path is
 * simply "not there"). */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * Frontend asset manifest of a packaged server: `scripts/build-server.ts`
 * stages `assets.json` next to the compiled binary, so an unpacked server
 * release serves the UI with no configuration (the desktop shell passes
 * the same path as LUMISCA_ASSETS_FILE). `execPath` is Deno.execPath():
 * a `bun run server` server (development) has no manifest next to the runtime,
 * so the repository sources stay authoritative there.
 *
 * Returns undefined when no manifest sits beside the executable.
 */
export function defaultAssetsFile(
  execPath: string,
  fileExists: (path: string) => boolean = isFile,
): string | undefined {
  const candidate = join(dirname(execPath), "assets.json");
  return fileExists(candidate) ? candidate : undefined;
}

/** Human-readable startup failure for a listen error. An occupied port
 * (the common case: another `bun run dev:server` still runs) names the
 * likely cause and the fix; anything else reports the raw detail. The web
 * dev server proxies a fixed port (see packages/web/vite.config.ts), so
 * silently falling over to another port would only break `bun run dev`
 * in a confusing way — fail loudly instead. */
export function describeListenError(
  host: string,
  port: number,
  error: unknown,
): string {
  if (isAddressInUseError(error)) {
    return [
      `Lumisca: ポート ${port} は既に使用されています ` +
        `(http://${host}:${port} で listen できません)。`,
      "別の Lumisca サーバーが起動中の可能性があります。",
      "対処: 起動中のサーバーを停止するか、別ポートで起動してください。",
      `  - 使用中プロセスの確認 (Windows): netstat -ano | findstr :${port}`,
      "  - プロセスの終了 (Windows): taskkill /PID <PID> /F",
      "  - 別ポートで起動 (PowerShell): $env:LUMISCA_PORT=8100; bun run dev:server",
    ].join("\n");
  }
  const detail = errorMessage(error);
  return `Lumisca: http://${host}:${port} で listen できません: ${detail}`;
}
