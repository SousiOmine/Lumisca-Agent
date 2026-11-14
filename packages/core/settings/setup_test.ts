import { join } from "node:path";
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
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("the setup marker lives beside the settings file", () => {
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

Deno.test("a missing marker means the setup is not done", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-setup-" });
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

Deno.test("deleting the marker asks for the setup again", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-setup-" });
  const marker = setupMarkerPath(dir);
  try {
    markSetupComplete(dir);
    assertEquals(readSetupState(dir), { completed: true });

    Deno.removeSync(marker);
    assertEquals(readSetupState(dir), { completed: false });
    // Writing it twice is harmless (finishing the wizard from two windows).
    markSetupComplete(dir);
    markSetupComplete(dir);
    assertEquals(readSetupState(dir), { completed: true });
  } finally {
    await removeDirRetry(dir);
  }
});

Deno.test("a core without a settings file owes no setup", async () => {
  // An in-memory core is a test's or a scratch instance's: there is nowhere
  // for the marker to live, so there is no installation to guide.
  const core = LumiscaCore.openInMemory();
  try {
    assertEquals(core.getSetup(), { completed: true });
    assertEquals(core.completeSetup(), { completed: true });
  } finally {
    await core.close();
  }
});

Deno.test("core: the marker is read per call, not fixed at startup", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-setup-" });
  const core = LumiscaCore.open(
    join(dir, "lumisca.db"),
    join(dir, "settings.jsonc"),
  );
  try {
    const marker = setupMarkerPath(dir);
    assertEquals(core.getSetup(), { completed: false });

    assertEquals(core.completeSetup(), { completed: true });
    assertEquals(markerExists(marker), true);
    assertEquals(core.getSetup(), { completed: true });

    // The documented way to ask for the wizard again: delete the file. The
    // same process must see it, without a restart.
    Deno.removeSync(marker);
    assertEquals(core.getSetup(), { completed: false });
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
});
