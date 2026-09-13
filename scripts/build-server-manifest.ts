/**
 * Write the update manifest of one server package.
 *
 * The release workflow runs this per platform, right after signing the
 * package, and uploads the result as `latest-server-<target>.json` (see
 * `.github/workflows/release.yml`). The layout it writes — the asset URL, the
 * manifest name, the target key — comes from `packages/server/update/
 * release.ts`, the same module the running server reads it back with, so a
 * URL or name that exists on only one side is impossible.
 *
 * Usage (from the repository root):
 *
 *   deno run --allow-read --allow-write scripts/build-server-manifest.ts \
 *     --archive dist/server/lumisca-server-0.7.8-windows-x64.zip \
 *     --signature dist/server/lumisca-server-0.7.8-windows-x64.zip.sig \
 *     --tag v0.7.8 --target x86_64-pc-windows-msvc \
 *     --out dist/server/latest-server-x86_64-pc-windows-msvc.json
 *
 * `--signature` also accepts the base64 signature itself (what
 * `tauri signer sign` prints), so a manifest can be written without a `.sig`
 * file on disk.
 */
import { basename, dirname, join } from "node:path";
import {
  archiveAssetName,
  manifestAssetName,
  parseReleaseManifest,
  releaseAssetUrl,
  releaseTargetFor,
} from "../packages/server/update/release.ts";
import { absolutePath, parseOptions, reportUsage } from "./lib.ts";

function usage(message?: string): never {
  reportUsage(
    "build-server-manifest",
    "deno run --allow-read --allow-write scripts/build-server-manifest.ts " +
      "--archive <path> --signature <path|base64> --tag <vX.Y.Z> " +
      "--target <deno target> [--out <path>]",
    message,
  );
}

interface Options {
  archive: string;
  signature: string;
  tag: string;
  target: string;
  out?: string;
}

function parseArgs(args: readonly string[]): Options {
  const values = parseOptions(args, usage);
  const required = ["archive", "signature", "tag", "target"] as const;
  for (const key of required) {
    if (!values.has(key)) usage(`--${key} is required`);
  }
  return {
    archive: absolutePath(values.get("archive")!),
    signature: values.get("signature")!,
    tag: values.get("tag")!,
    target: values.get("target")!,
    out: values.has("out") ? absolutePath(values.get("out")!) : undefined,
  };
}

const options = parseArgs(Deno.args);

const target = releaseTargetFor(options.target);
if (target === undefined) {
  usage(
    `--target ${options.target} is not a distributed platform ` +
      "(packages/server/update/release.ts)",
  );
}

const version = options.tag.replace(/^v/, "");
if (!/^\d+(\.\d+)*$/.test(version)) {
  usage(`--tag must look like vX.Y.Z, got "${options.tag}"`);
}

const assetName = basename(options.archive);
const expected = archiveAssetName(version, target);
if (assetName !== expected) {
  usage(
    `the archive is named "${assetName}" but the ${options.target} package ` +
      `of ${version} is "${expected}"`,
  );
}

const resolvedSignature = await (async (): Promise<string> => {
  if (options.signature.includes("/") || options.signature.includes("\\")) {
    const path = absolutePath(options.signature);
    try {
      return (await Deno.readTextFile(path)).trim();
    } catch (error) {
      usage(
        `cannot read --signature ${path}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return options.signature.trim();
})();

let size: number;
try {
  size = (await Deno.stat(options.archive)).size;
} catch (error) {
  usage(
    `cannot read --archive ${options.archive}: ` +
      (error instanceof Error ? error.message : String(error)),
  );
}

const out = options.out ??
  join(dirname(options.archive), manifestAssetName(options.target));
const manifest = {
  version,
  target: options.target,
  url: releaseAssetUrl(options.tag, assetName),
  size,
  signature: resolvedSignature,
};

// Read the document back through the runtime's parser: the release must not
// publish a manifest the updater would refuse.
parseReleaseManifest(manifest, options.target);
await Deno.writeTextFile(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Manifest: ${out} (${version}, ${options.target}, ${size} bytes, ` +
    `${assetName})`,
);
