import { join } from "node:path";
import { type EnvReader, processEnv } from "../models/custom.ts";

/** Directory (under the config home) holding this application's settings.
 * Shared with the service definition, which lives beside the settings file it
 * belongs to (packages/server/systemd/plan.ts). */
export const SETTINGS_DIR_NAME = "lumisca-agent";
const SETTINGS_FILE = "settings.jsonc";

/** Directory (inside the settings directory) holding the skills the app
 * itself writes: the Lumisca skills folder every agent of this mode shares.
 * Separated from the user's own `~/.agents/skills` on purpose — that folder
 * belongs to the user, and the file tools never reach it. */
export const SKILLS_DIR_NAME = "skills";

/** Location of the settings file: $XDG_CONFIG_HOME/lumisca-agent/settings.jsonc
 * when XDG_CONFIG_HOME is set, otherwise ~/.config/lumisca-agent/settings.jsonc
 * (on Windows: %USERPROFILE%\.config\lumisca-agent\settings.jsonc).
 *
 * The environment is a parameter, not a direct `Deno.env` read: the process
 * environment is shared by every test file the runner executes in parallel,
 * so a test that needs a different one passes it instead of mutating the
 * real thing. */
export function resolveSettingsPath(env: EnvReader = processEnv): string {
  return join(configHome(env), SETTINGS_DIR_NAME, SETTINGS_FILE);
}

/** The Lumisca skills folder (see {@link SKILLS_DIR_NAME}), or undefined
 * when the config home cannot be resolved (no USERPROFILE / HOME).
 *
 * Unlike the settings path this is not an error: a machine without a home
 * directory simply has no shared skills folder, and the discovery step
 * skips it (`skills/discover.ts`). */
export function resolveAppSkillsDir(
  env: EnvReader = processEnv,
): string | undefined {
  const home = configHomeOrUndefined(env);
  return home === undefined
    ? undefined
    : join(home, SETTINGS_DIR_NAME, SKILLS_DIR_NAME);
}

/** {@link resolveAppSkillsDir} in the list shape the skill discovery and the
 * sandbox take: one folder, or none. */
export function appSkillDirs(env: EnvReader = processEnv): string[] {
  const dir = resolveAppSkillsDir(env);
  return dir === undefined ? [] : [dir];
}

/** The config home, throwing when the home directory is unknown (the
 * settings file has nowhere to go). */
function configHome(env: EnvReader): string {
  const home = configHomeOrUndefined(env);
  if (home === undefined) {
    throw new Error(
      "Cannot resolve the home directory for the settings file (~/.config/lumisca-agent/settings.jsonc)",
    );
  }
  return home;
}

/** $XDG_CONFIG_HOME when set, otherwise `<home>/.config`; undefined when
 * neither XDG_CONFIG_HOME nor a home directory is present. */
function configHomeOrUndefined(env: EnvReader): string | undefined {
  const values = env();
  const configured = values["XDG_CONFIG_HOME"];
  if (configured !== undefined && configured !== "") return configured;
  // Windows uses USERPROFILE; POSIX uses HOME (Deno 2 removed Deno.homedir).
  const home = values["USERPROFILE"] ?? values["HOME"];
  if (home === undefined || home === "") return undefined;
  return join(home, ".config");
}
