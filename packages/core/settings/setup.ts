import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFileSync } from "../fs.ts";
import { type EnvReader, processEnv } from "../models/custom.ts";
import type { SetupState } from "../shared/mod.ts";
import { resolveSettingsDir } from "./path.ts";

/** The file whose existence says the first-run setup is done, kept beside the
 * settings file it belongs to.
 *
 * Existence is the whole answer and the file is empty: making one by hand is
 * the same as finishing the wizard, and deleting it is how the setup is asked
 * for again (the next page load). Nothing reads its contents, so there is no
 * version or timestamp in it to get wrong. */
export const SETUP_MARKER_FILE = "setup-complete";

/** Where the marker of one installation lives: beside settings.jsonc, so a
 * backup or a move of the config directory carries the two together. */
export function resolveSetupMarkerPath(env: EnvReader = processEnv): string {
  return setupMarkerPath(resolveSettingsDir(env));
}

/** {@link resolveSetupMarkerPath} for a settings directory already resolved
 * (a core knows its own; see LumiscaCore.getSetup). */
export function setupMarkerPath(settingsDir: string): string {
  return join(settingsDir, SETUP_MARKER_FILE);
}

/** Whether the setup of the installation whose settings live in
 * `settingsDir` is done.
 *
 * `settingsDir` is undefined for a core with no settings file at all (an
 * in-memory one: a test's, or a scratch instance's). There is nowhere for the
 * marker to live, so there is no installation to guide and the wizard is not
 * owed. */
export function readSetupState(settingsDir: string | undefined): SetupState {
  if (settingsDir === undefined) return { completed: true };
  return { completed: existsSync(setupMarkerPath(settingsDir)) };
}

/** Record that the setup is done: write the marker. Idempotent, and the
 * directory is created when it does not exist yet — the wizard can be
 * finished before any setting was written. */
export function markSetupComplete(settingsDir: string | undefined): SetupState {
  if (settingsDir === undefined) return { completed: true };
  const path = setupMarkerPath(settingsDir);
  if (!existsSync(path)) atomicWriteTextFileSync(path, "");
  return { completed: true };
}
