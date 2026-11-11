/**
 * The server-only environment, split out from `startup.ts` so a launcher
 * outside the workspace can consume it.
 *
 * `packages/desktop` is deliberately not a workspace member (its `src-tauri`
 * target would be linked into the compiled server), so `bun run dev:desktop`
 * resolves imports without the root tsconfig's `@lumisca/*` paths. Anything
 * it reaches must therefore be free of bare specifiers; `startup.ts` imports
 * `@lumisca/core` and cannot be that module. The key list and the capture
 * stay here — one source — and `startup.ts` re-exports them.
 */

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
 * `self` (default) restarts in place, `supervisor` exits and lets the
 * process supervisor (systemd) start the new binary, `none` leaves the
 * restart to the operator. */
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

export interface EnvironmentSource {
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
