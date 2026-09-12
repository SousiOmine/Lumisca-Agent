import { assertEquals, assertThrows } from "@std/assert";
import {
  archiveAssetName,
  compareVersions,
  defaultManifestUrl,
  isNewerVersion,
  manifestAssetName,
  parseReleaseManifest,
  parseVersion,
  RELEASE_TARGETS,
  releaseAssetUrl,
  ReleaseManifestError,
  releaseTargetFor,
} from "./release.ts";

const TARGET = "x86_64-pc-windows-msvc";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.7.8",
    target: TARGET,
    url: releaseAssetUrl(
      "v0.7.8",
      archiveAssetName("0.7.8", releaseTargetFor(TARGET)!),
    ),
    size: 107_587_972,
    signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
    ...overrides,
  };
}

Deno.test("the release layout names assets and URLs consistently", () => {
  const windows = releaseTargetFor("x86_64-pc-windows-msvc")!;
  const linux = releaseTargetFor("x86_64-unknown-linux-gnu")!;
  assertEquals(windows.format, "zip");
  assertEquals(linux.format, "tar.gz");
  assertEquals(
    archiveAssetName("0.7.8", windows),
    "lumisca-server-0.7.8-windows-x64.zip",
  );
  assertEquals(
    archiveAssetName("0.7.8", linux),
    "lumisca-server-0.7.8-linux-x64.tar.gz",
  );
  assertEquals(
    releaseAssetUrl("v0.7.8", "lumisca-server-0.7.8-windows-x64.zip"),
    "https://github.com/SousiOmine/Lumisca-Agent/releases/download/" +
      "v0.7.8/lumisca-server-0.7.8-windows-x64.zip",
  );
  // One manifest per platform: an unpublished platform simply has none.
  assertEquals(
    manifestAssetName("x86_64-pc-windows-msvc"),
    "latest-server-x86_64-pc-windows-msvc.json",
  );
  assertEquals(
    defaultManifestUrl("x86_64-unknown-linux-gnu"),
    "https://github.com/SousiOmine/Lumisca-Agent/releases/latest/download/" +
      "latest-server-x86_64-unknown-linux-gnu.json",
  );
  // Every shipped target resolves to a distinct platform label, and the
  // manifest name is derived from the target the running server reports.
  const labels = Object.values(RELEASE_TARGETS).map((t) => t.platform);
  assertEquals(new Set(labels).size, labels.length);
  assertEquals(releaseTargetFor("aarch64-apple-darwin"), undefined);
});

Deno.test("parseReleaseManifest accepts a complete manifest", () => {
  const parsed = parseReleaseManifest(manifest(), TARGET);
  assertEquals(parsed.version, "0.7.8");
  assertEquals(parsed.target, TARGET);
  assertEquals(parsed.size, 107_587_972);
  assertEquals(parsed.url.endsWith(".zip"), true);
});

Deno.test("parseReleaseManifest rejects what cannot be installed", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["not an object", { ...manifest(), ...{} }],
    ["no version", manifest({ version: undefined })],
    ["malformed version", manifest({ version: "0.7.8-beta" })],
    ["another target", manifest({ target: "aarch64-apple-darwin" })],
    ["relative url", manifest({ url: "/local/package.zip" })],
    ["unsupported scheme", manifest({ url: "ftp://example.com/package.zip" })],
    ["no size", manifest({ size: 0 })],
    ["fractional size", manifest({ size: 1.5 })],
    ["no signature", manifest({ signature: "" })],
  ];
  assertThrows(
    () => parseReleaseManifest(null, TARGET),
    ReleaseManifestError,
  );
  for (const [label, value] of cases.slice(1)) {
    assertThrows(
      () => parseReleaseManifest(value, TARGET),
      ReleaseManifestError,
      undefined,
      label,
    );
  }
});

Deno.test("versions compare numerically, not lexically", () => {
  assertEquals(parseVersion("0.7.8"), [0, 7, 8]);
  assertEquals(parseVersion(" 1.2 "), [1, 2]);
  assertEquals(parseVersion("v0.7.8"), null);
  assertEquals(parseVersion("0.7.8-rc1"), null);
  assertEquals(compareVersions("0.7.9", "0.7.10"), -1);
  assertEquals(compareVersions("0.8", "0.8.0"), 0);
  assertEquals(compareVersions("1.0.0", "0.9.9"), 1);
  assertThrows(() => compareVersions("nope", "0.7.8"), ReleaseManifestError);
});

Deno.test("isNewerVersion only accepts a strictly newer release", () => {
  assertEquals(isNewerVersion("0.7.8", "0.7.7"), true);
  assertEquals(isNewerVersion("0.7.10", "0.7.9"), true);
  assertEquals(isNewerVersion("0.7.7", "0.7.7"), false);
  assertEquals(isNewerVersion("0.7.6", "0.7.7"), false);
  // A release with an unparsable version is ignored rather than installed.
  assertEquals(isNewerVersion("latest", "0.7.7"), false);
  // A build whose own version is broken accepts any well-formed candidate,
  // instead of silently never updating.
  assertEquals(isNewerVersion("0.7.8", "unknown"), true);
});
