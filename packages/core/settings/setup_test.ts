import { test } from "bun:test";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, join as pathJoin } from "node:path";
import { openCore, openInMemoryCore } from "@lumisca/core";
import { assertEquals } from "@std/assert";
import { LumiscaCore } from "../core.ts";
import { removeDirRetry } from "../test-utils.ts";
import { resolveSettingsDir } from "./path.ts";
import {
  markSetupComplete,
  readSetupState,
  resolveSetupMarkerPath,
  SETUP_MARKER_FILE,
  setupMarkerPath,
} from "./setup.ts";

/** Whether the marker file is there, read through the filesystem rather than
 * through the code under test. */
function markerExists(path: string): boolean {
  try {
    fsSync.statSync(path);
    return true;
  } catch {
    return false;
  }
}

test("the setup marker lives beside the settings file", () => {
  const dir = resolveSettingsDir(() => ({
    XDG_CONFIG_HOME: join("C:", "xdg"),
  }));
  assertEquals(dir, join("C:", "xdg", "lumisca-agent"));
  assertEquals(
    resolveSetupMarkerPath(() => ({ XDG_CONFIG_HOME: join("C:", "xdg") })),
    join(dir, SETUP_MARKER_FILE),
  );
  assertEquals(
    setupMarkerPath(dir),
    resolveSetupMarkerPath(() => ({
      XDG_CONFIG_HOME: join("C:", "xdg"),
    })),
  );
});

test("a missing marker means the setup is not done", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-setup-"));
  try {
    // The directory itself may not exist yet: the wizard can be finished
    // before any setting was written.
    const missing = join(dir, "never-created");
    assertEquals(readSetupState(missing), { completed: false });

    assertEquals(markSetupComplete(missing), { completed: true });
    assertEquals(markerExists(setupMarkerPath(missing)), true);
    assertEquals(readSetupState(missing), { completed: true });
  } finally {
    await removeDirRetry(dir);
  }
});

test("deleting the marker asks for the setup again", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-setup-"));
  const marker = setupMarkerPath(dir);
  try {
    markSetupComplete(dir);
    assertEquals(readSetupState(dir), { completed: true });

    fsSync.rmSync(marker);
    assertEquals(readSetupState(dir), { completed: false });
    // Writing it twice is harmless (finishing the wizard from two windows).
    markSetupComplete(dir);
    markSetupComplete(dir);
    assertEquals(readSetupState(dir), { completed: true });
  } finally {
    await removeDirRetry(dir);
  }
});

test("a core without a settings file owes no setup", async () => {
  // An in-memory core is a test's or a scratch instance's: there is nowhere
  // for the marker to live, so there is no installation to guide.
  const core = openInMemoryCore();
  try {
    assertEquals(core.settings.setup(), { completed: true });
    assertEquals(core.settings.completeSetup(), { completed: true });
  } finally {
    await core.close();
  }
});

test("core: the marker is read per call, not fixed at startup", async () => {
  const dir = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-setup-"));
  const core = openCore(join(dir, "lumisca.db"), join(dir, "settings.jsonc"));
  try {
    const marker = setupMarkerPath(dir);
    assertEquals(core.settings.setup(), { completed: false });

    assertEquals(core.settings.completeSetup(), { completed: true });
    assertEquals(markerExists(marker), true);
    assertEquals(core.settings.setup(), { completed: true });

    // The documented way to ask for the wizard again: delete the file. The
    // same process must see it, without a restart.
    fsSync.rmSync(marker);
    assertEquals(core.settings.setup(), { completed: false });
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
});
