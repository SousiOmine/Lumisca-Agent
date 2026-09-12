/**
 * Release metadata of the standalone server distribution: where an update
 * manifest lives, which archive a given platform consumes, and how versions
 * are compared.
 *
 * This module is the single source of the release layout, shared by the
 * runtime updater and by `scripts/build-server-manifest.ts` (which writes
 * the manifests the release workflow publishes): a URL or asset name that
 * exists in only one of them is a bug, not a configuration choice.
 */

/** Repository whose GitHub Releases carry the server packages. */
export const RELEASE_REPOSITORY = "SousiOmine/Lumisca-Agent";

/** How a platform's package is compressed. Windows ships a zip (Explorer
 * double-click), the POSIX platforms a tar.gz (`tar -xzf`). */
export type ArchiveFormat = "zip" | "tar.gz";

/** The release identity of a `deno compile` target triple. */
export interface ReleaseTarget {
  /** Platform label used in the asset names (`lumisca-server-<v>-<platform>`). */
  platform: string;
  format: ArchiveFormat;
}

/**
 * Platforms the release workflow publishes. Keys are `Deno.build.target`
 * values, so the running server looks itself up with no configuration.
 * Adding a platform is one entry here plus one matrix row in
 * `.github/workflows/release.yml`; an unknown target simply has no updates
 * (the UI reports "この構成では利用できません") instead of fetching a
 * manifest that was never published.
 */
export const RELEASE_TARGETS: Readonly<Record<string, ReleaseTarget>> = {
  "x86_64-pc-windows-msvc": { platform: "windows-x64", format: "zip" },
  "x86_64-unknown-linux-gnu": { platform: "linux-x64", format: "tar.gz" },
};

/** Release identity of a target, or undefined when it is not distributed. */
export function releaseTargetFor(target: string): ReleaseTarget | undefined {
  return RELEASE_TARGETS[target];
}

/** Archive file name of a release (`lumisca-server-0.7.8-windows-x64.zip`). */
export function archiveAssetName(
  version: string,
  target: ReleaseTarget,
): string {
  return `lumisca-server-${version}-${target.platform}` +
    (target.format === "zip" ? ".zip" : ".tar.gz");
}

/** Manifest file name of a platform (`latest-server-<target>.json`). One
 * manifest per platform: the release matrix builds each platform in its own
 * job, so a single combined file would need a merge step (and a merge race)
 * for no benefit. */
export function manifestAssetName(target: string): string {
  return `latest-server-${target}.json`;
}

/** URL of a release asset, addressed by tag. */
export function releaseAssetUrl(tag: string, assetName: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${assetName}`;
}

/**
 * Where a server of this target looks for its update manifest. The
 * `latest` shortcut serves only the release GitHub considers latest — a
 * draft or a pre-release is invisible, so an unpublished release can never
 * be offered as an update. The URL needs no API token and no rate-limit
 * budget (unlike `api.github.com`).
 */
export function defaultManifestUrl(target: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/` +
    manifestAssetName(target);
}

/** What an update manifest says about this platform's package. */
export interface ReleaseManifest {
  /** Version of the release (e.g. "0.7.8"). */
  version: string;
  /** `Deno.build.target` the manifest was written for. */
  target: string;
  /** Absolute URL of the archive to download. */
  url: string;
  /** Archive size in bytes (progress display and a sanity check). */
  size: number;
  /** Base64 minisign signature over the archive (the `.sig` file's
   * content, exactly as `tauri signer sign` writes it). */
  signature: string;
}

/** A manifest that cannot be trusted to describe an installable package. */
export class ReleaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseManifestError";
  }
}

function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseManifestError(`更新マニフェストの ${field} が不正です`);
  }
  return value;
}

/**
 * Parse and validate a manifest for `expectedTarget`.
 *
 * The archive URL's scheme is *not* treated as a security boundary: the
 * payload is only ever installed after its signature verifies against the
 * compiled-in release key, so a forged manifest cannot point at an
 * attacker's archive. The scheme is still checked to keep a typo
 * (`httsp://…`) or a relative path from turning into a confusing download
 * error instead of a clear one.
 */
export function parseReleaseManifest(
  value: unknown,
  expectedTarget: string,
): ReleaseManifest {
  if (typeof value !== "object" || value === null) {
    throw new ReleaseManifestError(
      "更新マニフェストが JSON オブジェクトではありません",
    );
  }
  const record = value as Record<string, unknown>;
  const version = requireString(record.version, "version");
  if (parseVersion(version) === null) {
    throw new ReleaseManifestError(
      `更新マニフェストの version が不正です: "${version}"`,
    );
  }
  const target = requireString(record.target, "target");
  if (target !== expectedTarget) {
    throw new ReleaseManifestError(
      `更新マニフェストの対象が一致しません: "${target}" (この実行環境は "${expectedTarget}")`,
    );
  }
  const url = requireString(record.url, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReleaseManifestError(
      `更新マニフェストの url が不正です: "${url}"`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ReleaseManifestError(
      `更新マニフェストの url が http(s) ではありません: "${url}"`,
    );
  }
  const size = record.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    throw new ReleaseManifestError("更新マニフェストの size が不正です");
  }
  return {
    version,
    target,
    url,
    size,
    signature: requireString(record.signature, "signature"),
  };
}

/** Numeric segments of a version string, or null when it is not a plain
 * `major(.minor)*` version. Pre-release/build metadata is not used by this
 * project's tags, and accepting it silently would order releases wrongly. */
export function parseVersion(text: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)$/.exec(text.trim());
  if (match === null) return null;
  return match[1]!.split(".").map((part) => Number(part));
}

/** Compare two version strings segment by segment (missing segments count
 * as 0, so "0.8" and "0.8.0" are equal). */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    throw new ReleaseManifestError(
      `バージョン文字列が不正です: "${a}" / "${b}"`,
    );
  }
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether `candidate` is a version this build should update to. A build
 * whose own version is unparsable (a hand-edited constant) accepts any
 * well-formed candidate rather than silently never updating. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parsed = parseVersion(candidate);
  if (parsed === null) return false;
  if (parseVersion(current) === null) return true;
  return compareVersions(candidate, current) > 0;
}
