import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { withTempDir } from "@lumisca/core/test-utils";
import {
  applyStagedUpdate,
  cleanupStaleFiles,
  installedFileNames,
  type InstallEnvironment,
  InstallError,
  successorEnvironment,
} from "./install.ts";
import {
  readAppliedUpdate,
  readStagedUpdate,
  type StagedUpdate,
  stagingDir,
} from "./stage.ts";
import { buildTarGz, buildZip } from "./test-utils.ts";
import { PORT_WAIT_ENV_KEY } from "../startup.ts";

const BINARY = "lumisca-server.exe";
const NEXT = "0.7.8";
const CURRENT = "0.7.7";

interface InstallFixture {
  environment: InstallEnvironment;
  staged: StagedUpdate;
}

async function newPackage(
  installDir: string,
  format: "zip" | "tar.gz",
  files: Array<{ name: string; content: string }>,
): Promise<StagedUpdate> {
  const prefix = "lumisca-server-0.7.8-windows-x64";
  const entries = files.map((file) => ({
    name: `${prefix}/${file.name}`,
    content: file.content,
  }));
  const archive = format === "zip"
    ? await buildZip(entries)
    : await buildTarGz(entries);
  const archivePath = join(
    stagingDir(installDir),
    format === "zip" ? "update.zip" : "update.tar.gz",
  );
  await Deno.mkdir(stagingDir(installDir), { recursive: true });
  await Deno.writeFile(archivePath, archive);
  const staged: StagedUpdate = {
    version: NEXT,
    target: "x86_64-pc-windows-msvc",
    url: "https://example.com/package",
    signature: "unused-at-apply-time",
    size: archive.length,
    format,
    stagedAt: new Date().toISOString(),
    archivePath,
  };
  await Deno.writeTextFile(
    join(stagingDir(installDir), "staged.json"),
    JSON.stringify(staged, null, 2) + "\n",
  );
  return staged;
}

/** An installation with a running version 0.7.7 and a staged 0.7.8. */
async function fixture(
  installDir: string,
  format: "zip" | "tar.gz" = "zip",
): Promise<InstallFixture> {
  await Deno.writeTextFile(join(installDir, BINARY), "old-binary");
  await Deno.writeTextFile(join(installDir, "assets.json"), "old-assets");
  await Deno.writeTextFile(join(installDir, "icudtl.dat"), "old-icu");
  const staged = await newPackage(installDir, format, [
    { name: BINARY, content: "new-binary" },
    { name: "assets.json", content: "new-assets" },
    { name: "icudtl.dat", content: "new-icu" },
  ]);
  assertEquals(readStagedUpdate(installDir)?.version, NEXT);
  return {
    environment: { installDir, execPath: join(installDir, BINARY) },
    staged,
  };
}

function list(installDir: string): string[] {
  return [...Deno.readDirSync(installDir)].map((entry) => entry.name).sort();
}

Deno.test("applyStagedUpdate replaces the package files and records the version", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    const { environment, staged } = await fixture(installDir);
    const checked: string[] = [];
    const result = await applyStagedUpdate({
      environment,
      staged,
      currentVersion: CURRENT,
      versionCheck: (binary) => {
        checked.push(binary);
        return Promise.resolve(`${NEXT}\n`);
      },
    });

    assertEquals(result.version, NEXT);
    // The new files are in place…
    assertEquals(
      await Deno.readTextFile(join(installDir, BINARY)),
      "new-binary",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, "assets.json")),
      "new-assets",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, "icudtl.dat")),
      "new-icu",
    );
    // …the previous binary is kept aside for the next startup to remove…
    assertEquals(
      await Deno.readTextFile(join(installDir, `${BINARY}.old-${CURRENT}`)),
      "old-binary",
    );
    // …the staging names are gone…
    assertEquals(
      list(installDir).filter((name) => name.endsWith(".new")),
      [],
    );
    // …the package is consumed…
    assertEquals(readStagedUpdate(installDir), undefined);
    // …and the applied version is recorded (a restart finishes the update).
    assertEquals(readAppliedUpdate(installDir)?.version, NEXT);
    // The staged binary was run once, before anything was moved.
    assertEquals(checked.length, 1);
    assertEquals(checked[0]!.endsWith(`${BINARY}`), true);
  });
});

Deno.test("applyStagedUpdate works for a tar.gz package too", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    const { environment, staged } = await fixture(installDir, "tar.gz");
    await applyStagedUpdate({
      environment,
      staged,
      currentVersion: CURRENT,
      versionCheck: () => Promise.resolve(NEXT),
    });
    assertEquals(
      await Deno.readTextFile(join(installDir, BINARY)),
      "new-binary",
    );
    assertEquals(readAppliedUpdate(installDir)?.version, NEXT);
  });
});

Deno.test("applyStagedUpdate rolls back when a file cannot be replaced", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    const { environment, staged } = await fixture(installDir);
    // A non-empty directory where the second file's backup has to go:
    // renaming a file onto it fails on every platform, mid-swap (the binary
    // has already landed by then).
    const blocked = join(installDir, `assets.json.old-${CURRENT}`);
    await Deno.mkdir(blocked);
    await Deno.writeTextFile(join(blocked, "keep"), "x");

    await assertRejects(
      () =>
        applyStagedUpdate({
          environment,
          staged,
          currentVersion: CURRENT,
          versionCheck: () => Promise.resolve(NEXT),
        }),
      InstallError,
      "以前のファイルに戻しました",
    );

    // Every file is the previous version again…
    assertEquals(
      await Deno.readTextFile(join(installDir, BINARY)),
      "old-binary",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, "assets.json")),
      "old-assets",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, "icudtl.dat")),
      "old-icu",
    );
    // …no staging name survives…
    assertEquals(
      list(installDir).filter((name) => name.endsWith(".new")),
      [],
    );
    // …and the package is still staged, so the user can retry.
    assertEquals(readStagedUpdate(installDir)?.version, NEXT);
    assertEquals(readAppliedUpdate(installDir), undefined);
  });
});

Deno.test("applyStagedUpdate rolls back a file the package added", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    await Deno.writeTextFile(join(installDir, BINARY), "old-binary");
    await Deno.writeTextFile(join(installDir, "assets.json"), "old-assets");
    await Deno.writeTextFile(join(installDir, "icudtl.dat"), "old-icu");
    // The new package brings a file the running version does not have (a
    // future resource). It is swapped in before the next file fails, so the
    // rollback has to undo an ADDITION, not a replacement.
    const staged = await newPackage(installDir, "zip", [
      { name: BINARY, content: "new-binary" },
      { name: "extra.dat", content: "new-only" },
      { name: "assets.json", content: "new-assets" },
      { name: "icudtl.dat", content: "new-icu" },
    ]);
    // A non-empty directory where assets.json's backup has to go: the swap
    // fails there, after the binary and extra.dat already landed.
    const blocked = join(installDir, `assets.json.old-${CURRENT}`);
    await Deno.mkdir(blocked);
    await Deno.writeTextFile(join(blocked, "keep"), "x");

    await assertRejects(
      () =>
        applyStagedUpdate({
          environment: { installDir, execPath: join(installDir, BINARY) },
          staged,
          currentVersion: CURRENT,
          versionCheck: () => Promise.resolve(NEXT),
        }),
      InstallError,
      "以前のファイルに戻しました",
    );

    // The rollback restores the previous files AND removes the added one:
    // leaving it behind would mix two versions in one installation.
    assertEquals(list(installDir).includes("extra.dat"), false);
    assertEquals(
      await Deno.readTextFile(join(installDir, BINARY)),
      "old-binary",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, "assets.json")),
      "old-assets",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, "icudtl.dat")),
      "old-icu",
    );
    assertEquals(
      list(installDir).filter((name) => name.endsWith(".new")),
      [],
    );
  });
});

Deno.test("applyStagedUpdate refuses a binary that is not the promised version", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    const { environment, staged } = await fixture(installDir);
    await assertRejects(
      () =>
        applyStagedUpdate({
          environment,
          staged,
          currentVersion: CURRENT,
          versionCheck: () => Promise.resolve("0.7.9"),
        }),
      InstallError,
      "バージョンが一致しません",
    );
    // Nothing was touched (the staging area aside), and the package is
    // still staged.
    assertEquals(
      list(installDir).filter((name) => !name.startsWith(".")),
      ["assets.json", "icudtl.dat", BINARY].sort(),
    );
    assertEquals(readStagedUpdate(installDir)?.version, NEXT);
  });
});

Deno.test("applyStagedUpdate refuses a package without the server binary", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    await Deno.writeTextFile(join(installDir, BINARY), "old-binary");
    const staged = await newPackage(installDir, "zip", [
      { name: "assets.json", content: "new-assets" },
    ]);
    await assertRejects(
      () =>
        applyStagedUpdate({
          environment: { installDir, execPath: join(installDir, BINARY) },
          staged,
          currentVersion: CURRENT,
          versionCheck: () => Promise.resolve(NEXT),
        }),
      InstallError,
      "含まれていません",
    );
    assertEquals(
      await Deno.readTextFile(join(installDir, BINARY)),
      "old-binary",
    );
  });
});

Deno.test("cleanupStaleFiles removes update leftovers and nothing else", async () => {
  await withTempDir("lumisca-install-", async (installDir) => {
    const environment = { installDir, execPath: join(installDir, BINARY) };
    await Deno.writeTextFile(join(installDir, `${BINARY}.old-0.7.6`), "x");
    await Deno.writeTextFile(join(installDir, `assets.json.old-0.7.6`), "x");
    await Deno.writeTextFile(join(installDir, "icudtl.dat.new"), "x");
    await Deno.writeTextFile(join(installDir, "notes.txt"), "keep me");
    await Deno.writeTextFile(
      join(installDir, "restart-notes.old-1"),
      "keep me",
    );

    const removed = await cleanupStaleFiles(environment);
    assertEquals(
      new Set(removed),
      new Set([
        `${BINARY}.old-0.7.6`,
        "assets.json.old-0.7.6",
        "icudtl.dat.new",
      ]),
    );
    assertEquals(list(installDir), ["notes.txt", "restart-notes.old-1"]);
    // A missing directory is not an error (a development run has no
    // installation directory of its own).
    assertEquals(
      await cleanupStaleFiles({
        installDir: `${installDir}/nope`,
        execPath: BINARY,
      }),
      [],
    );
  });
});

Deno.test("successorEnvironment replays the launch configuration", () => {
  const env = successorEnvironment(
    {
      LUMISCA_PORT: "8100",
      LUMISCA_DB: "C:/data/lumisca.db",
      LUMISCA_HOME: undefined,
      LUMISCA_UPDATE_RESTART: undefined,
    },
    15_000,
  );
  assertEquals(env, {
    LUMISCA_PORT: "8100",
    LUMISCA_DB: "C:/data/lumisca.db",
    [PORT_WAIT_ENV_KEY]: "15000",
  });
  // Without a retry budget the successor keeps the fail-fast behavior.
  assertEquals(successorEnvironment({ LUMISCA_PORT: "8100" }, undefined), {
    LUMISCA_PORT: "8100",
  });
});

Deno.test("installedFileNames describes the package layout", () => {
  assertEquals(installedFileNames("/opt/lumisca/lumisca-server"), [
    "lumisca-server",
    "assets.json",
    "icudtl.dat",
  ]);
});
