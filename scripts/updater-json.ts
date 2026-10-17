/**
 * The desktop distribution's updater manifest (`latest.json`, the format
 * tauri-action writes) and the one thing this repository changes about it.
 *
 * tauri-action fills every platform entry's `url` with the GitHub *API*
 * asset endpoint (`api.github.com/repos/<owner>/<repo>/releases/assets/<id>`).
 * The installed app fetches that URL unauthenticated, and the API — unlike
 * the CDN behind a public download link — rejects a request without a
 * `User-Agent` header and allows only 60 unauthenticated requests per hour
 * per IP; over either limit it answers 403. The updater surfaces that as
 * "Download request failed with status: 403 Forbidden" even though the
 * update *check* succeeded, because the check reads the manifest through
 * `github.com` and never touches the API. Release v0.9.0 shipped that way
 * and the update could not be downloaded at all from a shared egress IP.
 *
 * So the manifest is rewritten before it is published: every platform URL
 * becomes the tag-addressed public download link of the asset it already
 * addresses (`releases/download/<tag>/<name>`), built by the same
 * `releaseAssetUrl` the server distribution uses
 * (`packages/server/update/release.ts`).
 *
 * The tag is an input, not something the asset list can supply: the rewrite
 * runs while the release is still a draft, and for a draft GitHub reports
 * each asset's public `url` as a placeholder
 * (`releases/download/untagged-<hash>/<name>`) that stops addressing the
 * asset once the release is published under its tag. The asset list stays
 * the authority for *which* asset a platform entry addresses: an entry is
 * rewritten when its URL is that asset's `apiUrl` (what tauri-action
 * writes), the asset's own public `url` (either form), or the tag link
 * itself (a second run over this module's output). Anything else — a URL
 * from a different release, a missing asset, a platform entry without a
 * signature — fails, because a manifest this module cannot map is one the
 * release must not publish.
 *
 * `scripts/rewrite-updater-json.ts` is the CLI over this module; the
 * runtime side of the desktop update lives in
 * `packages/desktop/src-tauri/src/update.rs`.
 */
import { releaseAssetUrl } from "../packages/server/update/release.ts";

/** One asset of a release, as `gh release view <tag> --json assets
 * --jq .assets` reports it (the fields this module reads). */
export interface ReleaseAsset {
  /** Asset file name, used for the report. */
  name: string;
  /** API asset URL — what tauri-action writes into the manifest. */
  apiUrl: string;
  /** Public download URL as GitHub reports it: the tag link once the
   * release is published, a placeholder (`untagged-<hash>`) while it is a
   * draft. */
  url: string;
}

/** One platform entry of the rewritten manifest, for the CLI's report. */
export interface LinkedPlatform {
  /** Manifest key (e.g. `darwin-aarch64`). */
  key: string;
  /** Name of the asset its URL now addresses. */
  asset: string;
  /** Whether the URL was replaced (false: it already was the tag's public
   * download link, which is what a second run over the same manifest
   * finds). */
  rewritten: boolean;
}

/** A manifest or asset list that cannot be rewritten. */
export class UpdaterJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdaterJsonError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new UpdaterJsonError(`${what} must be a non-empty string`);
  }
  return value;
}

/** Read the asset list `gh release view --json assets --jq .assets`
 * printed, refusing anything that is not a list of named assets. */
export function parseReleaseAssets(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) {
    throw new UpdaterJsonError("the asset list must be a JSON array");
  }
  if (value.length === 0) {
    throw new UpdaterJsonError("the asset list is empty");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new UpdaterJsonError(`asset ${index} is not an object`);
    }
    return {
      name: requireString(entry.name, `asset ${index}'s name`),
      apiUrl: requireString(entry.apiUrl, `asset ${index}'s apiUrl`),
      url: requireString(entry.url, `asset ${index}'s url`),
    };
  });
}

/** The manifest's platform URLs, all pointing at an asset's public
 * download URL, plus everything else the manifest carried (version, notes,
 * pub_date, unknown future fields — untouched). */
export interface UpdaterJsonRewrite {
  manifest: Record<string, unknown>;
  /** The manifest's `version`, validated. */
  version: string;
  /** One entry per platform, in manifest order. */
  platforms: LinkedPlatform[];
}

/** Replace every platform URL that addresses an asset of this release
 * (through the API, through a public link GitHub reported, or through the
 * tag link itself) with that asset's tag-addressed public download link. */
export function rewriteUpdaterJson(
  manifest: unknown,
  assets: readonly ReleaseAsset[],
  tag: string,
): UpdaterJsonRewrite {
  if (!isRecord(manifest)) {
    throw new UpdaterJsonError("the manifest must be a JSON object");
  }
  const version = requireString(manifest.version, "the manifest's version");
  requireString(tag, "the release tag");
  if (tag !== `v${version}`) {
    throw new UpdaterJsonError(
      `the release tag is ${tag}, but the manifest's version is ${version}: ` +
        "the links must address the tag the release is published under",
    );
  }
  const platforms = manifest.platforms;
  if (!isRecord(platforms) || Object.keys(platforms).length === 0) {
    throw new UpdaterJsonError(
      "the manifest's platforms must be a non-empty object",
    );
  }

  const byUrl = new Map<string, ReleaseAsset>();
  for (const asset of assets) {
    byUrl.set(asset.apiUrl, asset);
    byUrl.set(asset.url, asset);
    byUrl.set(releaseAssetUrl(tag, asset.name), asset);
  }

  const rewritten: [string, unknown][] = [];
  const linked: LinkedPlatform[] = [];
  for (const [key, entry] of Object.entries(platforms)) {
    if (key === "") {
      throw new UpdaterJsonError(
        "the manifest has a platform with an empty key",
      );
    }
    if (!isRecord(entry)) {
      throw new UpdaterJsonError(`platform "${key}" is not an object`);
    }
    requireString(entry.signature, `platform "${key}"'s signature`);
    const url = requireString(entry.url, `platform "${key}"'s url`);
    const asset = byUrl.get(url);
    if (asset === undefined) {
      throw new UpdaterJsonError(
        `platform "${key}" points at ${url}, which is not an asset of this release`,
      );
    }
    const link = releaseAssetUrl(tag, asset.name);
    rewritten.push([key, link === url ? entry : { ...entry, url: link }]);
    linked.push({ key, asset: asset.name, rewritten: link !== url });
  }

  return {
    // `Object.fromEntries`, not an assignment loop: a platform key is a
    // dynamic string from the manifest, and assigning one like `__proto__`
    // on a plain object would write the prototype instead of an own
    // property, silently dropping the entry from the published manifest.
    manifest: { ...manifest, platforms: Object.fromEntries(rewritten) },
    version,
    platforms: linked,
  };
}
