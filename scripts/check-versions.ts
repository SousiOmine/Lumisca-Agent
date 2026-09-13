/**
 * Assert that every manifest carrying the app version agrees.
 *
 * The version lives in eight files (three workspace `deno.json`s, the
 * desktop `deno.json`, the desktop `package.json`, `tauri.conf.json`,
 * `Cargo.toml`, and `packages/server/version.ts` — the constant a packaged
 * server reads at runtime, since the compiled binary has no manifests)
 * because each toolchain reads its own manifest. This script is the single
 * checker, run by CI on every change and by the release workflow against
 * the pushed tag, so a mismatch is caught before a release is published.
 *
 * Usage:
 *   deno run --allow-read scripts/check-versions.ts [expected]
 *
 * `expected` (e.g. `0.7.5`, or the tag with its `v` stripped) pins the
 * version to compare against; without it, `tauri.conf.json` is the
 * reference and every other manifest must match it.
 *
 * Exits 1 and prints `::error::` annotations on any mismatch.
 */
import { join } from "node:path";
import { repoRoot } from "./lib.ts";

interface Manifest {
  /** Path relative to the repository root. */
  path: string;
  /** How to read the version out of the file. */
  read: (text: string) => string | undefined;
}

function jsonVersion(text: string): string | undefined {
  const parsed = JSON.parse(text) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : undefined;
}

/** First `version = "x"` line (the `[package]` section's). */
function cargoVersion(text: string): string | undefined {
  return text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

/** `SERVER_VERSION = "x"` in the server's runtime version constant. */
function serverVersion(text: string): string | undefined {
  return text.match(/SERVER_VERSION\s*=\s*"([^"]+)"/)?.[1];
}

const REFERENCE = "packages/desktop/src-tauri/tauri.conf.json";

const MANIFESTS: Manifest[] = [
  { path: REFERENCE, read: jsonVersion },
  { path: "packages/core/deno.json", read: jsonVersion },
  { path: "packages/server/deno.json", read: jsonVersion },
  { path: "packages/server/version.ts", read: serverVersion },
  { path: "packages/web/deno.json", read: jsonVersion },
  { path: "packages/desktop/deno.json", read: jsonVersion },
  { path: "packages/desktop/package.json", read: jsonVersion },
  {
    path: "packages/desktop/src-tauri/Cargo.toml",
    read: cargoVersion,
  },
];

function readVersion(manifest: Manifest): string | undefined {
  try {
    return manifest.read(Deno.readTextFileSync(join(repoRoot, manifest.path)));
  } catch (error) {
    console.error(
      `::error::cannot read ${manifest.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}

const expected = Deno.args[0]?.replace(/^v/, "") ??
  readVersion(MANIFESTS[0]!);
if (expected === undefined) {
  console.error(`::error::no version found in ${REFERENCE}`);
  Deno.exit(1);
}

let failed = false;
for (const manifest of MANIFESTS) {
  const actual = readVersion(manifest);
  if (actual !== expected) {
    console.error(
      `::error::${manifest.path} has version ${
        actual ?? "(none)"
      }, expected ${expected}`,
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    `::error::Version mismatch: every manifest must carry ${expected}. ` +
      "Update them all before tagging.",
  );
  Deno.exit(1);
}

console.log(`Versions agree: ${expected} (${MANIFESTS.length} manifests)`);
