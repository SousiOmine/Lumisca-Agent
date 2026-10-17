import { assertEquals, assertThrows } from "@std/assert";
import {
  parseReleaseAssets,
  rewriteUpdaterJson,
  UpdaterJsonError,
} from "./updater-json.ts";

/** The tag the release is published under (the link the manifest must
 * carry). The manifest's version has to be this tag without its `v`. */
const TAG = "v0.9.0";

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

/** The same release while it is still a draft: GitHub reports each asset's
 * public URL under the placeholder the draft is served from, which stops
 * addressing the asset once the release is published with its tag. */
const DRAFT_ASSETS = ASSETS.map((asset) => ({
  ...asset,
  url: asset.url.replace("/download/v0.9.0/", "/download/untagged-db2f21/"),
}));

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

Deno.test("an API asset URL becomes the tag's public download link", () => {
  const rewrite = rewriteUpdaterJson(manifest(), ASSETS, TAG);

  assertEquals(rewrite.version, "0.9.0");
  assertEquals(rewrite.platforms, [
    { key: "darwin-aarch64", asset: APPLE.name, rewritten: true },
    { key: "darwin-aarch64-app", asset: APPLE.name, rewritten: true },
    { key: "windows-x86_64", asset: NSIS.name, rewritten: true },
    { key: "windows-x86_64-nsis", asset: NSIS.name, rewritten: true },
  ]);

  // Every URL is the tag link; the signatures and the rest of the manifest
  // (including the platform order) are untouched.
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

Deno.test("a draft's placeholder URLs become the tag's download links", () => {
  // What the rewrite finds on a draft release: the asset list reports the
  // `untagged-<hash>` placeholder, which must not reach the manifest — it
  // stops addressing the asset the moment the release is published.
  const rewrite = rewriteUpdaterJson(manifest(), DRAFT_ASSETS, TAG);
  const platforms = rewrite.manifest.platforms as Record<
    string,
    { url: string }
  >;

  assertEquals(platforms["darwin-aarch64"]!.url, APPLE.url);
  assertEquals(platforms["windows-x86_64-nsis"]!.url, NSIS.url);
  assertEquals(rewrite.platforms.every((entry) => entry.rewritten), true);
});

Deno.test("a manifest that already has the tag's links is left alone", () => {
  // What a second run over this script's own output finds.
  const published = rewriteUpdaterJson(manifest(), ASSETS, TAG).manifest;

  const again = rewriteUpdaterJson(
    JSON.parse(JSON.stringify(published)),
    ASSETS,
    TAG,
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

  const rewrite = rewriteUpdaterJson(withProtoKey, ASSETS, TAG);
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
    () => rewriteUpdaterJson(stale, ASSETS, TAG),
    UpdaterJsonError,
    'platform "darwin-aarch64" points at',
  );
});

Deno.test("a tag that does not match the manifest's version fails", () => {
  // The links would address a release the manifest does not belong to.
  assertThrows(
    () => rewriteUpdaterJson(manifest(), ASSETS, "v0.9.1"),
    UpdaterJsonError,
    "the release tag is v0.9.1, but the manifest's version is 0.9.0",
  );

  assertThrows(
    () => rewriteUpdaterJson(manifest(), ASSETS, "v"),
    UpdaterJsonError,
    "the release tag is v, but the manifest's version is 0.9.0",
  );

  assertThrows(
    () => rewriteUpdaterJson(manifest(), ASSETS, ""),
    UpdaterJsonError,
    "the release tag must be a non-empty string",
  );
});

Deno.test("a platform entry without a signature or a url fails", () => {
  const noSignature = manifest({
    platforms: { "darwin-aarch64": { url: APPLE.apiUrl } },
  });
  assertThrows(
    () => rewriteUpdaterJson(noSignature, ASSETS, TAG),
    UpdaterJsonError,
    `platform "darwin-aarch64"'s signature`,
  );

  const noUrl = manifest({
    platforms: { "darwin-aarch64": { signature: SIGNATURE } },
  });
  assertThrows(
    () => rewriteUpdaterJson(noUrl, ASSETS, TAG),
    UpdaterJsonError,
    `platform "darwin-aarch64"'s url`,
  );

  const notAnEntry = manifest({ platforms: { "darwin-aarch64": SIGNATURE } });
  assertThrows(
    () => rewriteUpdaterJson(notAnEntry, ASSETS, TAG),
    UpdaterJsonError,
    'platform "darwin-aarch64" is not an object',
  );
});

Deno.test("a manifest without a version or platforms fails", () => {
  const { version: _version, ...withoutVersion } = manifest();
  assertThrows(
    () => rewriteUpdaterJson(withoutVersion, ASSETS, TAG),
    UpdaterJsonError,
    "the manifest's version",
  );

  assertThrows(
    () => rewriteUpdaterJson(manifest({ platforms: {} }), ASSETS, TAG),
    UpdaterJsonError,
    "the manifest's platforms must be a non-empty object",
  );

  assertThrows(
    () => rewriteUpdaterJson("0.9.0", ASSETS, TAG),
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
