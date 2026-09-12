import { dirname, join } from "node:path";

/**
 * Environment key the updater uses to tell its successor how long it may
 * retry binding the port: the old process releases it milliseconds after the
 * successor starts, and Windows keeps TIME_WAIT sockets on it (binding then
 * fails until they drain). Declared before the list so both stay one source.
 */
export const PORT_WAIT_ENV_KEY = "LUMISCA_PORT_WAIT_MS";

/** Environment key the desktop shell sets on the server child it spawns:
 * the shell's own updater owns that binary (it lives in the app bundle), so
 * the server must not replace it. */
export const DESKTOP_ENV_KEY = "LUMISCA_DESKTOP";

/** Environment key overriding where update manifests are fetched from
 * (forks, self-hosted mirrors, and the release smoke tests). */
export const UPDATE_MANIFEST_ENV_KEY = "LUMISCA_UPDATE_MANIFEST";

/** Environment key selecting how an applied update is activated:
 * `self` (default) restarts in place, `none` leaves the restart to the
 * operator (or to the process supervisor). */
export const UPDATE_RESTART_ENV_KEY = "LUMISCA_UPDATE_RESTART";

export const SERVER_STARTUP_ENV_KEYS = [
  "LUMISCA_DB",
  "LUMISCA_HOME",
  "LUMISCA_REPO_ROOT",
  "LUMISCA_ALLOWED_HOSTS",
  "LUMISCA_BROWSER_IPC_URL",
  "LUMISCA_BROWSER_TOKEN",
  "LUMISCA_TOKEN",
  "LUMISCA_HOST",
  "LUMISCA_PORT",
  "LUMISCA_ASSETS_FILE",
  DESKTOP_ENV_KEY,
  UPDATE_MANIFEST_ENV_KEY,
  UPDATE_RESTART_ENV_KEY,
  PORT_WAIT_ENV_KEY,
] as const;

type ServerEnvKey = (typeof SERVER_STARTUP_ENV_KEYS)[number];

interface EnvironmentSource {
  get(key: string): string | undefined;
  delete(key: string): void;
}

/**
 * Server-launch configuration captured before the agent starts accepting
 * work. These values configure this process only; they must not leak into
 * commands launched by the coding tools, where they could make a nested
 * Lumisca instance reuse its parent's port, database, token, or browser.
 */
export type ServerStartupEnvironment = Readonly<
  Record<ServerEnvKey, string | undefined>
>;

/**
 * Capture and remove every server-only environment variable synchronously in
 * the startup path. Deno.Command inherits the current process environment, so
 * consuming these values before LumiscaCore is created isolates all later
 * bash, background, and MCP children from the hosting server instance.
 */
export function consumeServerStartupEnvironment(
  source: EnvironmentSource = Deno.env,
): ServerStartupEnvironment {
  const values = Object.fromEntries(
    SERVER_STARTUP_ENV_KEYS.map((key) => [key, source.get(key)]),
  ) as Record<ServerEnvKey, string | undefined>;

  for (const key of SERVER_STARTUP_ENV_KEYS) source.delete(key);
  return values;
}

/** Parse LUMISCA_PORT into a valid TCP port. Empty/unset → `fallback`.
 * Throws with a human-readable message for non-integers and out-of-range
 * values (the caller reports it and exits before touching the database). */
export function parseServerPort(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `LUMISCA_PORT が不正です: "${raw}" (1〜65535 の整数を指定してください)`,
    );
  }
  return port;
}

/** True when a listen failure means "someone else holds this port". */
export function isAddressInUseError(error: unknown): boolean {
  return error instanceof Deno.errors.AddrInUse ||
    (error instanceof Error && error.name === "AddrInUse");
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
 * its installation: a `deno run` server is the repository, and the desktop
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
export function updateSupport(
  options: { desktopManaged: boolean; standalone: boolean },
): { enabled: boolean; reason?: string } {
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
        "開発実行 (deno run) では自動アップデートを利用できません。パッケージ済みサーバーでのみ有効です",
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
export type UpdateRestartMode = "self" | "none";

export function parseUpdateRestartMode(
  raw: string | undefined,
): UpdateRestartMode {
  return raw?.trim().toLowerCase() === "none" ? "none" : "self";
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
 * a `deno run` server (development) has no manifest next to the runtime,
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
 * (the common case: another `deno task dev:server` still runs) names the
 * likely cause and the fix; anything else reports the raw detail. The web
 * dev server proxies a fixed port (see packages/web/vite.config.ts), so
 * silently falling over to another port would only break `deno task dev`
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
      "  - 別ポートで起動 (PowerShell): $env:LUMISCA_PORT=8100; deno task dev:server",
    ].join("\n");
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Lumisca: http://${host}:${port} で listen できません: ${detail}`;
}
