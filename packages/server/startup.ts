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
