import { join } from "node:path";

const SETTINGS_DIR = "lumisca-agent";
const SETTINGS_FILE = "settings.jsonc";

/** Location of the settings file: $XDG_CONFIG_HOME/lumisca-agent/settings.jsonc
 * when XDG_CONFIG_HOME is set, otherwise ~/.config/lumisca-agent/settings.jsonc
 * (on Windows: %USERPROFILE%\.config\lumisca-agent\settings.jsonc). */
export function resolveSettingsPath(): string {
  const configHome = Deno.env.get("XDG_CONFIG_HOME") ??
    join(homeDir(), ".config");
  return join(configHome, SETTINGS_DIR, SETTINGS_FILE);
}

function homeDir(): string {
  // Windows uses USERPROFILE; POSIX uses HOME (Deno 2 removed Deno.homedir).
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME");
  if (home === undefined || home === "") {
    throw new Error(
      "Cannot resolve the home directory for the settings file (~/.config/lumisca-agent/settings.jsonc)",
    );
  }
  return home;
}
