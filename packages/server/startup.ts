import { dirname, join } from "node:path";

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
