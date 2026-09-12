import { assertEquals, assertRejects } from "@std/assert";
import { withTempDir } from "@lumisca/core/test-utils";
import type { ReleaseManifest } from "./release.ts";
import {
  clearStaging,
  readAppliedUpdate,
  readStagedUpdate,
  stageUpdate,
  UpdateDownloadError,
  writeAppliedUpdate,
} from "./stage.ts";
import { buildTarGz, createSigningKeys } from "./test-utils.ts";

const TARGET = "x86_64-unknown-linux-gnu";
const STAGING = ".lumisca-update";

/** A fetch that answers with the given bytes (or an error status). */
function fakeFetch(
  body: Uint8Array<ArrayBuffer> | string,
  options: { status?: number } = {},
): typeof fetch {
  return ((_input: RequestInfo | URL) => {
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body;
    return Promise.resolve(
      options.status === undefined || options.status === 200
        ? new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        })
        : new Response(null, { status: options.status }),
    );
  }) as typeof fetch;
}

/** A signed package as the release workflow would publish it. */
async function packageFixture(
  overrides: Partial<ReleaseManifest> = {},
): Promise<{
  manifest: ReleaseManifest;
  archive: Uint8Array<ArrayBuffer>;
  publicKey: string;
}> {
  const archive = await buildTarGz([
    { name: "lumisca-server-0.7.8-linux-x64/lumisca-server", content: "new" },
    { name: "lumisca-server-0.7.8-linux-x64/assets.json", content: "{}" },
  ]);
  const keys = await createSigningKeys();
  const path = await Deno.makeTempFile({ prefix: "lumisca-stage-" });
  try {
    await Deno.writeFile(path, archive);
    const signature = await keys.sign(path);
    return {
      manifest: {
        version: "0.7.8",
        target: TARGET,
        url: "https://example.com/lumisca-server-0.7.8-linux-x64.tar.gz",
        size: archive.length,
        signature,
        ...overrides,
      },
      archive: archive as Uint8Array<ArrayBuffer>,
      publicKey: keys.publicKey,
    };
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

function stagingEntries(installDir: string): string[] {
  try {
    return [...Deno.readDirSync(`${installDir}/${STAGING}`)]
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

Deno.test("stageUpdate records the verified package and its metadata", async () => {
  await withTempDir("lumisca-stage-", async (installDir) => {
    const { manifest, archive, publicKey } = await packageFixture();
    const received: number[] = [];
    const staged = await stageUpdate({
      installDir,
      manifest,
      fetch: fakeFetch(archive),
      publicKey,
      onProgress: (progress) => received.push(progress.received),
    });

    assertEquals(staged.version, "0.7.8");
    assertEquals(staged.format, "tar.gz");
    assertEquals(received.at(-1), archive.length);
    assertEquals(stagingEntries(installDir), ["staged.json", "update.tar.gz"]);

    // A restart must not re-download 100 MB: the staged package is read back
    // from the staging area.
    const read = readStagedUpdate(installDir);
    assertEquals(read?.version, "0.7.8");
    assertEquals(read?.archivePath, staged.archivePath);
    assertEquals(
      (await Deno.readFile(staged.archivePath)).length,
      archive.length,
    );

    // Staging the same version again replaces the package in place.
    const again = await stageUpdate({
      installDir,
      manifest,
      fetch: fakeFetch(archive),
      publicKey,
    });
    assertEquals(again.archivePath, staged.archivePath);
    assertEquals(stagingEntries(installDir), ["staged.json", "update.tar.gz"]);

    await clearStaging(installDir);
    assertEquals(readStagedUpdate(installDir), undefined);
    assertEquals(stagingEntries(installDir), []);
  });
});

Deno.test("stageUpdate leaves nothing behind when a package is rejected", async () => {
  await withTempDir("lumisca-stage-", async (installDir) => {
    const { manifest, archive, publicKey } = await packageFixture();
    const other = await createSigningKeys();

    // A body shorter than the declared size (a truncated download).
    await assertRejects(
      () =>
        stageUpdate({
          installDir,
          manifest: { ...manifest, size: archive.length + 10 },
          fetch: fakeFetch(archive),
          publicKey,
        }),
      UpdateDownloadError,
      "サイズが一致しません",
    );

    // A body longer than the declared size (a broken or hostile mirror):
    // the download stops instead of filling the disk.
    await assertRejects(
      () =>
        stageUpdate({
          installDir,
          manifest: { ...manifest, size: archive.length - 10 },
          fetch: fakeFetch(archive),
          publicKey,
        }),
      UpdateDownloadError,
      "想定サイズを超えています",
    );

    // An HTTP failure.
    await assertRejects(
      () =>
        stageUpdate({
          installDir,
          manifest,
          fetch: fakeFetch("", { status: 404 }),
          publicKey,
        }),
      UpdateDownloadError,
      "HTTP 404",
    );

    // A tampered archive.
    const tampered = new Uint8Array(archive);
    tampered[0] = tampered[0]! ^ 0xff;
    await assertRejects(
      () =>
        stageUpdate({
          installDir,
          manifest,
          fetch: fakeFetch(tampered),
          publicKey,
        }),
      Error,
      "署名",
    );

    // A package signed with another key is not installed either.
    await assertRejects(
      () =>
        stageUpdate({
          installDir,
          manifest,
          fetch: fakeFetch(archive),
          publicKey: other.publicKey,
        }),
      Error,
      "鍵 id が公開鍵と一致しません",
    );

    assertEquals(
      stagingEntries(installDir),
      [],
      "no partial download survives",
    );
  });
});

Deno.test("stageUpdate refuses a target that is not distributed", async () => {
  await withTempDir("lumisca-stage-", async (installDir) => {
    const { manifest } = await packageFixture();
    await assertRejects(
      () =>
        stageUpdate({
          installDir,
          manifest: { ...manifest, target: "aarch64-apple-darwin" },
          fetch: fakeFetch(""),
        }),
      UpdateDownloadError,
      "配布されていません",
    );
  });
});

Deno.test("applied markers round-trip and ignore malformed files", async () => {
  await withTempDir("lumisca-stage-", async (installDir) => {
    assertEquals(readAppliedUpdate(installDir), undefined);
    await writeAppliedUpdate(installDir, "0.7.8");
    assertEquals(readAppliedUpdate(installDir)?.version, "0.7.8");

    await Deno.writeTextFile(
      `${installDir}/${STAGING}/applied.json`,
      "{ not json",
    );
    assertEquals(readAppliedUpdate(installDir), undefined);

    // A staged marker without its archive (or without valid fields) means
    // "nothing staged", not a crash.
    await Deno.writeTextFile(
      `${installDir}/${STAGING}/staged.json`,
      JSON.stringify({ version: "0.7.8" }),
    );
    assertEquals(readStagedUpdate(installDir), undefined);
  });
});
