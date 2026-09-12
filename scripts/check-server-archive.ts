/**
 * Verify a packaged server archive the way the updater will: check its
 * signature against the compiled-in release key, then extract it with the
 * shipped extractor and compare the result with the staged build the archive
 * was made from.
 *
 * The release workflow runs this for every published archive (both
 * platforms), so a container the updater cannot read, a signature it cannot
 * verify, or a package missing the server binary fails before the release is
 * published — instead of on a user's machine, halfway through an update.
 *
 * Usage (from the repository root):
 *
 *   deno run --allow-read --allow-write scripts/check-server-archive.ts \
 *     --archive dist/server/lumisca-server-0.7.8-windows-x64.zip \
 *     --signature dist/server/lumisca-server-0.7.8-windows-x64.zip.sig \
 *     --stage dist/server/stage/x86_64-pc-windows-msvc \
 *     [--bin lumisca-server.exe] [--public-key <base64>]
 *
 * `--stage` is the directory `deno task build:server` produced on the same
 * machine. Without `--bin` the binary name is derived from the archive's
 * platform (the manifest's target is not part of an archive, so the caller
 * states it when the archive does not carry the standard name).
 * `--public-key` checks against another key (a local dry run with a
 * throwaway signing key); the release workflow leaves it out so every
 * published package is checked against the key servers actually carry.
 */
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  type ArchiveFormat,
  extractArchive,
} from "../packages/server/update/archive.ts";
import { verifyFileSignature } from "../packages/server/update/verify.ts";

function usage(message?: string): never {
  const stream = message === undefined ? console.log : console.error;
  if (message !== undefined) console.error(`check-server-archive: ${message}`);
  stream(
    "usage: deno run --allow-read --allow-write scripts/check-server-archive.ts " +
      "--archive <path> --signature <path> --stage <dir> [--bin <name>] " +
      "[--public-key <base64>]",
  );
  Deno.exit(message === undefined ? 0 : 1);
}

interface Options {
  archive: string;
  signature: string;
  stage: string;
  bin?: string;
  publicKey?: string;
}

function parseArgs(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) usage(`unknown argument: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      usage(`${arg} needs a value`);
    }
    values.set(arg.slice(2), value);
    i++;
  }
  for (const key of ["archive", "signature", "stage"] as const) {
    if (!values.has(key)) usage(`--${key} is required`);
  }
  const absolute = (path: string) =>
    isAbsolute(path) ? path : resolve(Deno.cwd(), path);
  return {
    archive: absolute(values.get("archive")!),
    signature: absolute(values.get("signature")!),
    stage: absolute(values.get("stage")!),
    bin: values.get("bin"),
    publicKey: values.get("public-key"),
  };
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const options = parseArgs(Deno.args);
const archiveName = basename(options.archive);
const format: ArchiveFormat = archiveName.endsWith(".zip") ? "zip" : "tar.gz";
const binaryName = options.bin ??
  (format === "zip" ? "lumisca-server.exe" : "lumisca-server");

console.log(`Verifying ${options.archive}`);

// 1. The signature, exactly as the updater checks it after downloading.
try {
  await verifyFileSignature({
    file: options.archive,
    signature: await Deno.readTextFile(options.signature),
    publicKey: options.publicKey,
  });
  check("signature verifies against the release key", true);
} catch (error) {
  check(
    "signature verifies against the release key",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

// 2. The container the updater reads, and the files inside it.
const extractDir = await Deno.makeTempDir({ prefix: "lumisca-archive-check-" });
try {
  const extracted = await extractArchive(options.archive, format, extractDir);
  check(
    "archive extracts",
    true,
    `${extracted.length} file(s): ${extracted.join(", ")}`,
  );
  check("package contains the server binary", extracted.includes(binaryName));

  // Every extracted file must be byte-identical to the build it came from:
  // a stale stage directory (or a packaging step that grabbed the wrong
  // file) would otherwise ship a package the updater installs happily and
  // that behaves differently from what was tested.
  for (const name of extracted) {
    const staged = join(options.stage, name);
    let same = false;
    let detail = "";
    try {
      const [fromArchive, fromStage] = await Promise.all([
        Deno.readFile(join(extractDir, name)),
        Deno.readFile(staged),
      ]);
      same = fromArchive.length === fromStage.length &&
        fromArchive.every((byte, index) => byte === fromStage[index]);
      detail = `${fromArchive.length} bytes`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    check(`${name} matches the staged build`, same, detail);
  }
} catch (error) {
  check(
    "archive extracts",
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  await Deno.remove(extractDir, { recursive: true }).catch(() => {});
}

if (failures.length > 0) {
  console.error(`check-server-archive: FAILED (${failures.join("; ")})`);
  Deno.exit(1);
}
console.log("check-server-archive: the package installs as an update");
