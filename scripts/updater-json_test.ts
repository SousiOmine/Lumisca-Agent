import { assertEquals, assertThrows } from "@std/assert";
import {
  parseReleaseAssets,
  rewriteUpdaterJson,
  UpdaterJsonError,
} from "./updater-json.ts";

/** Two assets as `gh release view <tag> --json assets --jq .assets`
 * reports them (the fields the rewrite reads). */
const APPLE = {
  name: "Lumisca_0.9.0_aarch64.app.tar.gz",
  apiUrl:
    "https://api.github.com/repos/SousiOmine/Lumisca-Agent/releases/assets/642668642",
  url: "https://github.com/SousiOmine/Lumisca-Agent/releases/download/v0.9.0/" +
    "Lumisca_0.9.0_aarch64.app.tar.gz",
};

const NSIS = {
  name: "Lumisca_0.9.0_x64-setup.exe",
  apiUrl:
    "https://api.github.com/repos/SousiOmine/Lumisca-Agent/releases/assets/642672118",
  url: "https://github.com/SousiOmine/Lumisca-Agent/releases/download/v0.9.0/" +
    "Lumisca_0.9.0_x64-setup.exe",
};

const ASSETS = [APPLE, NSIS];

const SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=";

/** A manifest in the shape tauri-action writes: every platform URL is the
 * API asset URL, and the installer variants of a platform share their
 * platform's asset. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.9.0",
    notes: "",
    pub_date: "2026-10-15T04:34:17.114Z",
    platforms: {
      "darwin-aarch64": { signature: SIGNATURE, url: APPLE.apiUrl },
      "darwin-aarch64-app": { signature: SIGNATURE, url: APPLE.apiUrl },
      "windows-x86_64": { signature: SIGNATURE, url: NSIS.apiUrl },
      "windows-x86_64-nsis": { signature: SIGNATURE, url: NSIS.apiUrl },
    },
    ...overrides,
  };
}

Deno.test("an API asset URL becomes the asset's public download URL", () => {
  const rewrite = rewriteUpdaterJson(manifest(), ASSETS);

  assertEquals(rewrite.version, "0.9.0");
  assertEquals(rewrite.platforms, [
    { key: "darwin-aarch64", asset: APPLE.name, rewritten: true },
    { key: "darwin-aarch64-app", asset: APPLE.name, rewritten: true },
    { key: "windows-x86_64", asset: NSIS.name, rewritten: true },
    { key: "windows-x86_64-nsis", asset: NSIS.name, rewritten: true },
  ]);

  // Every URL is the public link; the signatures and the rest of the
  // manifest (including the platform order) are untouched.
  assertEquals(rewrite.manifest, {
    version: "0.9.0",
    notes: "",
    pub_date: "2026-10-15T04:34:17.114Z",
    platforms: {
      "darwin-aarch64": { signature: SIGNATURE, url: APPLE.url },
      "darwin-aarch64-app": { signature: SIGNATURE, url: APPLE.url },
      "windows-x86_64": { signature: SIGNATURE, url: NSIS.url },
      "windows-x86_64-nsis": { signature: SIGNATURE, url: NSIS.url },
    },
  });
  assertEquals(
    Object.keys(rewrite.manifest),
    ["version", "notes", "pub_date", "platforms"],
  );
});

Deno.test("a manifest that already has public download URLs is left alone", () => {
  // What a second run over this script's own output finds.
  const published = rewriteUpdaterJson(manifest(), ASSETS).manifest;

  const again = rewriteUpdaterJson(
    JSON.parse(JSON.stringify(published)),
    ASSETS,
  );

  assertEquals(again.manifest, published);
  assertEquals(again.platforms.every((entry) => !entry.rewritten), true);
});

Deno.test("a platform key like __proto__ stays an own property", () => {
  // The keys come from the manifest, so a key a plain object would treat as
  // a prototype write must survive as the own property the manifest had.
  const withProtoKey = manifest({
    platforms: {
      ["__proto__"]: { signature: SIGNATURE, url: APPLE.apiUrl },
    },
  });

  const rewrite = rewriteUpdaterJson(withProtoKey, ASSETS);
  const platforms = rewrite.manifest.platforms as Record<string, unknown>;

  assertEquals(Object.getOwnPropertyNames(platforms), ["__proto__"]);
  const published = JSON.parse(JSON.stringify(rewrite.manifest));
  assertEquals(published.platforms["__proto__"].signature, SIGNATURE);
  assertEquals(published.platforms["__proto__"].url, APPLE.url);
});

Deno.test("a URL that is no asset of the release fails", () => {
  const stale = manifest({
    platforms: {
      "darwin-aarch64": {
        signature: SIGNATURE,
        url: "https://api.github.com/repos/SousiOmine/Lumisca-Agent/releases/" +
          "assets/1",
      },
    },
  });

  assertThrows(
    () => rewriteUpdaterJson(stale, ASSETS),
    UpdaterJsonError,
    'platform "darwin-aarch64" points at',
  );
});

Deno.test("a platform entry without a signature or a url fails", () => {
  const noSignature = manifest({
    platforms: { "darwin-aarch64": { url: APPLE.apiUrl } },
  });
  assertThrows(
    () => rewriteUpdaterJson(noSignature, ASSETS),
    UpdaterJsonError,
    `platform "darwin-aarch64"'s signature`,
  );

  const noUrl = manifest({
    platforms: { "darwin-aarch64": { signature: SIGNATURE } },
  });
  assertThrows(
    () => rewriteUpdaterJson(noUrl, ASSETS),
    UpdaterJsonError,
    `platform "darwin-aarch64"'s url`,
  );

  const notAnEntry = manifest({ platforms: { "darwin-aarch64": SIGNATURE } });
  assertThrows(
    () => rewriteUpdaterJson(notAnEntry, ASSETS),
    UpdaterJsonError,
    'platform "darwin-aarch64" is not an object',
  );
});

Deno.test("a manifest without a version or platforms fails", () => {
  const { version: _version, ...withoutVersion } = manifest();
  assertThrows(
    () => rewriteUpdaterJson(withoutVersion, ASSETS),
    UpdaterJsonError,
    "the manifest's version",
  );

  assertThrows(
    () => rewriteUpdaterJson(manifest({ platforms: {} }), ASSETS),
    UpdaterJsonError,
    "the manifest's platforms must be a non-empty object",
  );

  assertThrows(
    () => rewriteUpdaterJson("0.9.0", ASSETS),
    UpdaterJsonError,
    "the manifest must be a JSON object",
  );
});

Deno.test("the asset list must be a list of named assets", () => {
  assertEquals(parseReleaseAssets(ASSETS), ASSETS);

  assertThrows(
    () => parseReleaseAssets({ assets: ASSETS }),
    UpdaterJsonError,
    "the asset list must be a JSON array",
  );

  assertThrows(
    () => parseReleaseAssets([]),
    UpdaterJsonError,
    "the asset list is empty",
  );

  assertThrows(
    () => parseReleaseAssets([{ name: "a", url: "https://github.com/x" }]),
    UpdaterJsonError,
    "asset 0's apiUrl",
  );

  assertThrows(
    () => parseReleaseAssets(["Lumisca_0.9.0_aarch64.app.tar.gz"]),
    UpdaterJsonError,
    "asset 0 is not an object",
  );
});
