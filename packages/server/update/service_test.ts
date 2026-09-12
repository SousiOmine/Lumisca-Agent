import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { withTempDir } from "@lumisca/core/test-utils";
import { UPDATE_AUTO_KEY, UPDATE_AUTO_RESTART_KEY } from "@lumisca/core/shared";
import type { ReleaseManifest } from "./release.ts";
import { readAppliedUpdate, readStagedUpdate, stageUpdate } from "./stage.ts";
import { UpdateService, type UpdateServiceOptions } from "./service.ts";
import { buildTarGz, createSigningKeys } from "./test-utils.ts";
import { PORT_WAIT_ENV_KEY } from "../startup.ts";

const TARGET = "x86_64-unknown-linux-gnu";
const BINARY = "lumisca-server";
const CURRENT = "0.7.7";
const NEXT = "0.7.8";
const MANIFEST_URL = "https://example.com/latest-server.json";
const ARCHIVE_URL = "https://example.com/lumisca-server-0.7.8-linux-x64.tar.gz";

/** A release as the workflow publishes it: an archive, its signature, and
 * the manifest that points at both. */
async function packageFixture(
  version = NEXT,
  overrides: Partial<ReleaseManifest> = {},
): Promise<{
  manifest: ReleaseManifest;
  publicKey: string;
  fetch: typeof fetch;
}> {
  const prefix = `lumisca-server-${version}-linux-x64`;
  const archive = await buildTarGz([
    { name: `${prefix}/${BINARY}`, content: `binary-${version}` },
    { name: `${prefix}/assets.json`, content: `assets-${version}` },
    { name: `${prefix}/icudtl.dat`, content: `icu-${version}` },
  ]);
  const keys = await createSigningKeys();
  const path = await Deno.makeTempFile({ prefix: "lumisca-service-" });
  try {
    await Deno.writeFile(path, archive);
    const signature = await keys.sign(path);
    const manifest: ReleaseManifest = {
      version,
      target: TARGET,
      url: ARCHIVE_URL,
      size: archive.length,
      signature,
      ...overrides,
    };
    const fetchStub = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === MANIFEST_URL) {
        return Promise.resolve(
          new Response(JSON.stringify(manifest), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url === ARCHIVE_URL) return Promise.resolve(new Response(archive));
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch;
    return { manifest, publicKey: keys.publicKey, fetch: fetchStub };
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

interface Harness {
  service: UpdateService;
  settings: Map<string, string>;
  events: string[];
  exitCodes: number[];
  successors: Array<Record<string, unknown>>;
}

interface HarnessOptions {
  fixture: { publicKey: string; fetch: typeof fetch };
  settings?: Record<string, string>;
  restartMode?: "self" | "none";
  currentVersion?: string;
  versionCheck?: () => Promise<string>;
  overrides?: Partial<UpdateServiceOptions>;
}

function harness(installDir: string, options: HarnessOptions): Harness {
  const settings = new Map(Object.entries(options.settings ?? {}));
  const events: string[] = [];
  const exitCodes: number[] = [];
  const successors: Array<Record<string, unknown>> = [];
  const service = new UpdateService({
    environment: { installDir, execPath: join(installDir, BINARY) },
    settings: {
      getSetting: (key) => settings.get(key),
      setSetting: (key, value) => void settings.set(key, value),
    },
    startupEnv: {
      LUMISCA_PORT: "8100",
      LUMISCA_DB: join(installDir, "lumisca.db"),
      LUMISCA_UPDATE_RESTART: undefined,
    },
    cwd: installDir,
    manifestUrl: MANIFEST_URL,
    restartMode: options.restartMode ?? "self",
    currentVersion: options.currentVersion ?? CURRENT,
    target: TARGET,
    publicKey: options.fixture.publicKey,
    fetch: options.fixture.fetch,
    restartDelayMs: 0,
    successorPortWaitMs: 15_000,
    versionCheck: options.versionCheck ?? (() => Promise.resolve(NEXT)),
    shutdown: () => {
      events.push("shutdown");
      return Promise.resolve();
    },
    exit: (code) => {
      events.push("exit");
      exitCodes.push(code);
    },
    spawnSuccessor: (successorOptions) => {
      events.push("spawn");
      successors.push(successorOptions as unknown as Record<string, unknown>);
      return 4242;
    },
    ...options.overrides,
  });
  return { service, settings, events, exitCodes, successors };
}

/** The files of an installation running version 0.7.7 (their contents are
 * only markers here: the version check is injected). */
async function seedInstall(dir: string): Promise<void> {
  await Deno.writeTextFile(join(dir, BINARY), "binary-0.7.7");
  await Deno.writeTextFile(join(dir, "assets.json"), "assets-0.7.7");
  await Deno.writeTextFile(join(dir, "icudtl.dat"), "icu-0.7.7");
}

/** Wait until `predicate` holds (a restart is scheduled, not inline). */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test("a manual check reports the available release without downloading", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    const { service } = harness(dir, {
      fixture,
      settings: { [UPDATE_AUTO_KEY]: "0" },
    });
    assertEquals(service.status().supported, true);
    assertEquals(service.status().latestVersion, null);

    const status = await service.check();
    assertEquals(status.checking, false);
    assertEquals(status.available, true);
    assertEquals(status.latestVersion, NEXT);
    assertEquals(status.downloading, false);
    assertEquals(status.ready, false);
    assertEquals(status.error, null);
    assertEquals(readStagedUpdate(dir), undefined, "nothing was downloaded");
  });
});

Deno.test("automatic mode downloads, verifies and applies the package", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    const { service } = harness(dir, { fixture });

    const status = await service.check(true);
    assertEquals(status.available, true);
    assertEquals(status.ready, false, "the package is consumed by the apply");
    assertEquals(status.applied, true);
    assertEquals(status.appliedVersion, NEXT);
    assertEquals(status.restartPending, true);
    assertEquals(status.error, null);
    assertEquals(status.downloading, false);

    // The files on disk are the new version…
    assertEquals(await Deno.readTextFile(join(dir, BINARY)), `binary-${NEXT}`);
    assertEquals(
      await Deno.readTextFile(join(dir, "assets.json")),
      `assets-${NEXT}`,
    );
    // …the previous binary is kept for the next startup to clean up…
    assertEquals(
      (await Deno.stat(join(dir, `${BINARY}.old-${CURRENT}`))).isFile,
      true,
    );
    // …the applied version is recorded… and no restart happened (that is the
    // user's decision).
    assertEquals(readAppliedUpdate(dir)?.version, NEXT);
    assertEquals(service.status().restarting, false);
  });
});

Deno.test("restart hands over to a successor with the original launch configuration", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    const test = harness(dir, { fixture });
    await test.service.check(true);
    assertEquals(test.service.status().restartPending, true);

    const status = await test.service.restart();
    assertEquals(status.restarting, true);
    await waitFor(() => test.exitCodes.length > 0);

    // The server releases its resources, starts the successor with the
    // configuration this process was launched with, then exits.
    assertEquals(test.events, ["shutdown", "spawn", "exit"]);
    assertEquals(test.exitCodes, [0]);
    const successor = test.successors[0]!;
    assertEquals(successor.execPath, join(dir, BINARY));
    assertEquals(successor.cwd, dir);
    // The launch configuration is replayed (undefined values dropped), with
    // a bind-retry budget so a port the old process has not released yet
    // does not kill the new one.
    assertEquals(successor.env, {
      LUMISCA_PORT: "8100",
      LUMISCA_DB: join(dir, "lumisca.db"),
      [PORT_WAIT_ENV_KEY]: "15000",
    });
    // The successor outlives this process by design.
    assertEquals(test.service.status().restarting, true);
  });
});

Deno.test("the automatic restart setting restarts once the update is applied", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    const test = harness(dir, {
      fixture,
      settings: { [UPDATE_AUTO_RESTART_KEY]: "1" },
    });
    await test.service.check(true);
    await waitFor(() => test.exitCodes.length > 0);
    assertEquals(test.events, ["shutdown", "spawn", "exit"]);
    assertEquals(test.service.status().autoRestart, true);
  });
});

Deno.test("a supervised installation is not restarted by the server", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    const test = harness(dir, { fixture, restartMode: "none" });
    await test.service.check(true);

    const status = await test.service.restart();
    assertEquals(status.restarting, false);
    assertEquals(status.error?.includes("LUMISCA_UPDATE_RESTART=none"), true);
    assertEquals(test.events, []);
    // The update itself is applied: only the restart is skipped.
    assertEquals(status.restartPending, true);
    assertEquals(await Deno.readTextFile(join(dir, BINARY)), `binary-${NEXT}`);
  });
});

Deno.test("a failed check reports the reason and keeps the server usable", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    const failing = harness(dir, {
      fixture,
      overrides: {
        fetch: (() =>
          Promise.resolve(
            new Response(null, { status: 503 }),
          )) as typeof fetch,
      },
    });
    const status = await failing.service.check();
    assertEquals(status.available, false);
    assertEquals(status.checking, false);
    assertEquals(status.error?.includes("HTTP 503"), true);

    // A malformed manifest is refused with its reason, not with a crash.
    const broken = harness(dir, {
      fixture,
      overrides: {
        fetch: (() =>
          Promise.resolve(
            new Response(JSON.stringify({ version: "next" })),
          )) as typeof fetch,
      },
    });
    const brokenStatus = await broken.service.check();
    assertEquals(brokenStatus.error?.includes("更新マニフェスト"), true);
    assertEquals(brokenStatus.checking, false);
  });
});

Deno.test("a release that is not newer is ignored", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture(CURRENT);
    const { service } = harness(dir, { fixture });
    const status = await service.check(true);
    assertEquals(status.available, false);
    assertEquals(status.latestVersion, null);
    assertEquals(status.ready, false);
    assertEquals(status.error, null);
  });
});

Deno.test("a package staged by a previous run is ready to install", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    await stageUpdate({
      installDir: dir,
      manifest: fixture.manifest,
      fetch: fixture.fetch,
      publicKey: fixture.publicKey,
    });

    const { service } = harness(dir, {
      fixture,
      settings: { [UPDATE_AUTO_KEY]: "0" },
    });
    const status = service.status();
    assertEquals(status.ready, true);
    assertEquals(status.available, true);
    assertEquals(status.latestVersion, NEXT);
    assertEquals(status.applied, false);

    // Installing it uses the staged package (no further download).
    const applied = await service.apply();
    assertEquals(applied.applied, true);
    assertEquals(applied.restartPending, true);
    assertEquals(await Deno.readTextFile(join(dir, BINARY)), `binary-${NEXT}`);

    // A fresh process seeing the applied marker reports "a restart finishes
    // the update" instead of offering the same package again.
    const restarted = harness(dir, { fixture }).service;
    assertEquals(restarted.status().restartPending, true);
    assertEquals(restarted.status().appliedVersion, NEXT);
    assertEquals(restarted.status().ready, false);
  });
});

Deno.test("a staged package that is no longer newer is dropped", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    await stageUpdate({
      installDir: dir,
      manifest: fixture.manifest,
      fetch: fixture.fetch,
      publicKey: fixture.publicKey,
    });
    // The running version is already the staged one (a manual install
    // overtook the updater): the staging area must not keep offering it.
    const { service } = harness(dir, { fixture, currentVersion: NEXT });
    assertEquals(service.status().ready, false);
    await waitFor(() => readStagedUpdate(dir) === undefined);
    assertEquals(readStagedUpdate(dir), undefined);
  });
});

Deno.test("an installation whose target has no release reports why", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    // Whether this installation may update itself at all is decided at
    // startup (startup.updateSupport, covered by startup_test.ts) — the
    // composition root then registers no update endpoints. What is left to
    // the service is a target with no server distribution: the UI shows the
    // reason instead of the controls.
    const unpublished = harness(dir, {
      fixture,
      overrides: { target: "aarch64-apple-darwin" },
    }).service;
    assertEquals(unpublished.status().supported, false);
    assertEquals(
      unpublished.status().unsupportedReason?.includes("aarch64-apple-darwin"),
      true,
    );
    // Every action is a no-op, so this installation never reaches the
    // network or its own files.
    assertEquals((await unpublished.check()).available, false);
    assertEquals((await unpublished.download()).ready, false);
    assertEquals((await unpublished.apply()).applied, false);
    assertEquals(readStagedUpdate(dir), undefined);
  });
});

Deno.test("the toggles persist into the settings store", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    const test = harness(dir, {
      fixture,
      settings: { [UPDATE_AUTO_KEY]: "0" },
    });
    assertEquals(test.service.status().autoUpdate, false);
    // Turning the automatic update on checks right away.
    assertEquals(test.service.setAuto(true).autoUpdate, true);
    assertEquals(test.settings.get(UPDATE_AUTO_KEY), "1");
    await waitFor(() => test.service.status().available);

    // Turning the automatic restart on while an update is pending restarts.
    assertEquals(test.service.setAutoRestart(true).autoRestart, true);
    assertEquals(test.settings.get(UPDATE_AUTO_RESTART_KEY), "1");
    await waitFor(() => test.exitCodes.length > 0);
    assertEquals(test.events.includes("spawn"), true);
  });
});

Deno.test("apply keeps the staged package when the version check fails", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    await stageUpdate({
      installDir: dir,
      manifest: fixture.manifest,
      fetch: fixture.fetch,
      publicKey: fixture.publicKey,
    });
    const test = harness(dir, {
      fixture,
      versionCheck: () => Promise.resolve("0.7.9"),
    });
    const status = await test.service.apply();
    assertEquals(status.applied, false);
    assertEquals(status.error?.includes("バージョンが一致しません"), true);
    // The package is kept, so a retry does not re-download 100 MB…
    assertEquals(readStagedUpdate(dir)?.version, NEXT);
    assertEquals(await Deno.readTextFile(join(dir, BINARY)), "binary-0.7.7");

    // …and the same instance applies it once the binary reports the
    // promised version.
    const retry = harness(dir, { fixture });
    assertEquals((await retry.service.apply()).applied, true);
    assertEquals(await Deno.readTextFile(join(dir, BINARY)), `binary-${NEXT}`);
  });
});

Deno.test("the status payload is JSON-serializable and complete", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    const { service } = harness(dir, { fixture });
    const status = service.status();
    assertEquals(JSON.parse(JSON.stringify(status)), status);
    assertEquals(Object.keys(status).sort(), [
      "applied",
      "appliedVersion",
      "autoRestart",
      "autoUpdate",
      "available",
      "checking",
      "currentVersion",
      "downloaded",
      "downloading",
      "error",
      "latestVersion",
      "progress",
      "ready",
      "restartMode",
      "restartPending",
      "restarting",
      "supported",
      "target",
      "total",
      "unsupportedReason",
    ]);
  });
});

Deno.test("dispose stops the periodic check", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    const test = harness(dir, { fixture });
    test.service.start();
    test.service.dispose();
    // Disposing twice (a shutdown path plus an exit hook) is safe.
    test.service.dispose();
    assertEquals(test.service.status().checking, false);
  });
});

Deno.test("dispose ends the periodic chain even while a check is in flight", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    const fixture = await packageFixture();
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness(dir, {
      fixture,
      overrides: {
        firstCheckDelayMs: 0,
        checkIntervalMs: 20,
        fetch: (() => {
          calls++;
          // The server goes down mid-check: the tick must not re-arm.
          return gate.then(() => new Response(null, { status: 503 }));
        }) as typeof fetch,
      },
    });
    test.service.start();
    await waitFor(() => calls === 1);
    test.service.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(calls, 1, "a disposed service must not check again");
  });
});

Deno.test("a restart that cannot start its successor ends the process", async () => {
  await withTempDir("lumisca-service-", async (dir) => {
    await seedInstall(dir);
    const fixture = await packageFixture();
    const test = harness(dir, {
      fixture,
      overrides: {
        spawnSuccessor: () => {
          throw new Error("アクセスが拒否されました");
        },
      },
    });
    await test.service.check(true);
    await test.service.restart();
    await waitFor(() => test.exitCodes.length > 0);

    // The listener and the database are already released, so this process
    // can never serve again: it must exit (non-zero) instead of lingering
    // unreachable, with nothing able to report the failure to the user.
    assertEquals(test.exitCodes, [1]);
    assertEquals(test.events, ["shutdown", "exit"]);
    assertEquals(
      test.service.status().error?.includes("アクセスが拒否されました"),
      true,
    );
  });
});
