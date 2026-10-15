import { join } from "node:path";
import { type EnvReader, processEnv } from "../models/custom.ts";

/** Directory (under the config home) holding this application's settings.
 * Shared with the service definition, which lives beside the settings file it
 * belongs to (packages/server/systemd/plan.ts). */
export const SETTINGS_DIR_NAME = "lumisca-agent";
const SETTINGS_FILE = "settings.jsonc";

/** Location of the settings file: $XDG_CONFIG_HOME/lumisca-agent/settings.jsonc
 * when XDG_CONFIG_HOME is set, otherwise ~/.config/lumisca-agent/settings.jsonc
 * (on Windows: %USERPROFILE%\.config\lumisca-agent\settings.jsonc).
 *
 * The environment is a parameter, not a direct `Deno.env` read: the process
 * environment is shared by every test file the runner executes in parallel,
 * so a test that needs a different one passes it instead of mutating the
 * real thing. */
export function resolveSettingsPath(env: EnvReader = processEnv): string {
  const values = env();
  const configHome = values["XDG_CONFIG_HOME"] ??
    join(homeDir(values), ".config");
  return join(configHome, SETTINGS_DIR_NAME, SETTINGS_FILE);
}

/** The user's home directory; throws when neither USERPROFILE nor HOME is
 * set (a machine the settings file cannot be placed on). */
function homeDir(values: Record<string, string>): string {
  // Windows uses USERPROFILE; POSIX uses HOME (Deno 2 removed Deno.homedir).
  const home = values["USERPROFILE"] ?? values["HOME"];
  if (home === undefined || home === "") {
    throw new Error(
      "Cannot resolve the home directory for the settings file (~/.config/lumisca-agent/settings.jsonc)",
    );
  }
  return home;
}
