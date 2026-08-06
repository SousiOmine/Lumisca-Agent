import { join } from "node:path";
import { existsSync } from "node:fs";

/** Matches the esbuild version in deno.lock / node_modules. */
const ESBUILD_VERSION = "0.25.12";

function esbuildBinaryName(): string {
  return Deno.build.os === "windows" ? "esbuild.exe" : "bin/esbuild";
}

/** Locate the esbuild native binary inside the local node_modules. */
function esbuildBinaryPath(): string {
  const osName = Deno.build.os === "windows"
    ? "win32"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
  const arch = Deno.build.arch === "x86_64" ? "x64" : "arm64";
  const binaryName = esbuildBinaryName();
  const pkgDir = `@esbuild/${osName}-${arch}`;

  const candidates = [
    // Deno isolated layout: node_modules/.deno/@esbuild+win32-x64@<ver>/node_modules/@esbuild/win32-x64/
    join(
      Deno.cwd(),
      "node_modules",
      ".deno",
      `@esbuild+${osName}-${arch}@${ESBUILD_VERSION}`,
      "node_modules",
      pkgDir,
      binaryName,
    ),
    // Hoisted npm layout: node_modules/@esbuild/win32-x64/
    join(Deno.cwd(), "node_modules", pkgDir, binaryName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "esbuild binary not found. Run `deno cache npm:esbuild` (or `deno install`) first.",
  );
}

export interface BundleOptions {
  /** Repository root (used as esbuild working directory for node_modules resolution). */
  cwd: string;
  entry: string;
  outfile: string;
}

/** Bundle the client entry with the esbuild native binary (CLI mode). */
export async function bundleClient(options: BundleOptions): Promise<void> {
  const exe = esbuildBinaryPath();
  const args = [
    options.entry,
    "--bundle",
    "--format=esm",
    "--platform=browser",
    "--jsx=automatic",
    `--outfile=${options.outfile}`,
    "--log-level=warning",
    '--define:process.env.NODE_ENV="production"',
  ];
  const cmd = new Deno.Command(exe, {
    args,
    cwd: options.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(stderr || `esbuild exited with code ${result.code}`);
  }
}
