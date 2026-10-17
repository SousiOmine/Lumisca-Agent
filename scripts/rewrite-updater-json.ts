/**
 * Rewrite the desktop updater manifest so every platform URL is a public
 * download link instead of the GitHub API asset endpoint the app cannot
 * fetch from a rate-limited or proxied IP (see `scripts/updater-json.ts`
 * for why, and `packages/desktop/src-tauri/src/update.rs` for the failing
 * side).
 *
 * The release workflow runs this on the draft release right after the
 * desktop matrix uploaded `latest.json`, before the draft may be published,
 * and the same workflow can be dispatched on its own to repair an already
 * published release.
 *
 * Usage (from the repository root):
 *
 *   gh release view v0.9.0 --json assets --jq .assets > dist/updater/assets.json
 *   gh release download v0.9.0 -p latest.json -D dist/updater --clobber
 *   deno run --allow-read --allow-write scripts/rewrite-updater-json.ts \
 *     --manifest dist/updater/latest.json \
 *     --assets dist/updater/assets.json \
 *     --tag v0.9.0 \
 *     --out dist/updater/latest.json
 *   gh release upload v0.9.0 dist/updater/latest.json --clobber
 *
 * `--assets` is the release's asset list as `gh` reports it, and `--tag` is
 * the tag the release is published under — the links must address it and
 * the asset list alone cannot supply it (see `scripts/updater-json.ts`).
 * Each platform URL that is an asset's API URL, the asset's reported public
 * URL, or the tag link itself is replaced with the tag link, so re-running
 * this over its own output is a no-op; anything else fails — a manifest
 * whose URLs cannot be mapped must not reach users. `--out` may be the
 * input path: the manifest is read before it is written.
 */
import { absolutePath, parseOptions, reportUsage } from "./lib.ts";
import {
  parseReleaseAssets,
  rewriteUpdaterJson,
  UpdaterJsonError,
} from "./updater-json.ts";

function usage(message?: string): never {
  reportUsage(
    "rewrite-updater-json",
    "deno run --allow-read --allow-write scripts/rewrite-updater-json.ts " +
      "--manifest <latest.json> --assets <gh asset list> --tag <vX.Y.Z> " +
      "--out <path>",
    message,
  );
}

interface Options {
  manifest: string;
  assets: string;
  tag: string;
  out: string;
}

function parseArgs(args: readonly string[]): Options {
  const values = parseOptions(args, usage);
  const required = ["manifest", "assets", "tag", "out"] as const;
  for (const key of required) {
    if (!values.has(key)) usage(`--${key} is required`);
  }
  return {
    manifest: absolutePath(values.get("manifest")!),
    assets: absolutePath(values.get("assets")!),
    tag: values.get("tag")!,
    out: absolutePath(values.get("out")!),
  };
}

function fail(message: string): never {
  console.error(`rewrite-updater-json: ${message}`);
  Deno.exit(1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    fail(`cannot read ${what} ${path}: ${describe(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${what} ${path} is not valid JSON: ${describe(error)}`);
  }
}

const options = parseArgs(Deno.args);

const rewrite = await (async () => {
  const manifest = await readJson(options.manifest, "manifest");
  const assets = parseReleaseAssets(
    await readJson(options.assets, "asset list"),
  );
  try {
    return rewriteUpdaterJson(manifest, assets, options.tag);
  } catch (error) {
    // A manifest this module refuses to map is the expected failure; any
    // other error is a bug and must keep its stack.
    if (error instanceof UpdaterJsonError) fail(error.message);
    throw error;
  }
})();

const document = JSON.stringify(rewrite.manifest, null, 2) + "\n";
try {
  await Deno.writeTextFile(options.out, document);
} catch (error) {
  fail(`cannot write ${options.out}: ${describe(error)}`);
}

for (const platform of rewrite.platforms) {
  console.log(
    `${platform.key} -> ${platform.asset}` +
      (platform.rewritten ? "" : " (already the public download URL)"),
  );
}
console.log(
  `Updater manifest ${options.out}: ${rewrite.platforms.length} platform ` +
    `URLs point at public download links (version ${rewrite.version})`,
);
