/**
 * Staging: download a release package, verify it, and keep it next to the
 * server until it is applied.
 *
 * Everything lives in `<install dir>/.lumisca-update/`, i.e. on the same
 * volume as the binary the update eventually replaces (the swap is a rename,
 * never a cross-volume copy). The archive is only recorded as staged after
 * its signature verified, so a crash mid-download leaves either a previous
 * good package or nothing — never a half package that "looks" ready.
 */
import { join } from "node:path";
import type { ArchiveFormat, ReleaseManifest } from "./release.ts";
import { releaseTargetFor } from "./release.ts";
import { verifyFileSignature } from "./verify.ts";

/** Sub-directory of the install directory that holds staged packages. */
export const STAGING_DIR_NAME = ".lumisca-update";
export const STAGED_METADATA_FILE = "staged.json";
export const APPLIED_METADATA_FILE = "applied.json";
/** Base name of the staged archive (the extension follows the format). */
const STAGED_ARCHIVE_BASE = "update";
const PART_SUFFIX = ".part";
/** Extraction directory inside the staging directory. */
export const EXTRACT_DIR_NAME = "extract";

/** A downloaded, verified package waiting to be applied. */
export interface StagedUpdate {
  version: string;
  target: string;
  url: string;
  signature: string;
  /** Declared archive size in bytes. */
  size: number;
  format: ArchiveFormat;
  /** When the package finished verifying (ISO 8601). */
  stagedAt: string;
  /** Absolute path of the verified archive. */
  archivePath: string;
}

/** Marker written once a package's files are in place (before restart). */
export interface AppliedUpdate {
  version: string;
  appliedAt: string;
}

/** Directory holding the staging area of an installation. */
export function stagingDir(installDir: string): string {
  return join(installDir, STAGING_DIR_NAME);
}

/** Path of the staged archive for a format. */
export function stagedArchivePath(
  installDir: string,
  format: ArchiveFormat,
): string {
  const extension = format === "zip" ? ".zip" : ".tar.gz";
  return join(stagingDir(installDir), `${STAGED_ARCHIVE_BASE}${extension}`);
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(path));
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    // Missing, unreadable, or malformed: treated as "nothing staged".
    return undefined;
  }
}

/** The staged package of this installation, or undefined when none is
 * complete (a malformed or partially written marker counts as none). */
export function readStagedUpdate(
  installDir: string,
): StagedUpdate | undefined {
  const record = readJson(join(stagingDir(installDir), STAGED_METADATA_FILE));
  if (record === undefined) return undefined;
  const { version, target, url, signature, size, format, stagedAt } = record;
  if (
    typeof version !== "string" || typeof target !== "string" ||
    typeof url !== "string" || typeof signature !== "string" ||
    typeof size !== "number" || typeof stagedAt !== "string" ||
    (format !== "zip" && format !== "tar.gz")
  ) {
    return undefined;
  }
  const archivePath = stagedArchivePath(installDir, format);
  try {
    if (!Deno.statSync(archivePath).isFile) return undefined;
  } catch {
    return undefined;
  }
  return {
    version,
    target,
    url,
    signature,
    size,
    format,
    stagedAt,
    archivePath,
  };
}

/** The applied marker of this installation, if any. */
export function readAppliedUpdate(
  installDir: string,
): AppliedUpdate | undefined {
  const record = readJson(join(stagingDir(installDir), APPLIED_METADATA_FILE));
  if (record === undefined) return undefined;
  const { version, appliedAt } = record;
  if (typeof version !== "string" || typeof appliedAt !== "string") {
    return undefined;
  }
  return { version, appliedAt };
}

/** Record that `version`'s files are in place. */
export async function writeAppliedUpdate(
  installDir: string,
  version: string,
): Promise<void> {
  const dir = stagingDir(installDir);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, APPLIED_METADATA_FILE),
    JSON.stringify(
      { version, appliedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
}

/** Remove the staging area entirely (nothing staged, nothing pending). */
export async function clearStaging(installDir: string): Promise<void> {
  await Deno.remove(stagingDir(installDir), { recursive: true }).catch(
    () => {},
  );
}

/** Remove the staged package and its metadata, keeping the applied marker
 * (and the in-flight download's `.part` file, which the download owns). */
async function clearStagedPackage(installDir: string): Promise<void> {
  const dir = stagingDir(installDir);
  for (const format of ["zip", "tar.gz"] as const) {
    await Deno.remove(stagedArchivePath(installDir, format)).catch(() => {});
  }
  await Deno.remove(join(dir, STAGED_METADATA_FILE)).catch(() => {});
}

/** Progress of a running download. */
export interface DownloadProgress {
  /** Bytes written so far. */
  received: number;
  /** Expected total (Content-Length, else the manifest's size). */
  total: number | undefined;
}

export interface StageOptions {
  /** Directory that holds the server binary. */
  installDir: string;
  manifest: ReleaseManifest;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Release key to verify against (tests and forks pass their own). */
  publicKey?: string;
}

/** An update that could not be downloaded or verified. */
export class UpdateDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateDownloadError";
  }
}

const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Download and verify the package described by `manifest`.
 *
 * The body is streamed to disk (packages are ~100 MB, so it never sits in
 * memory), checked against the declared size, and only then verified
 * against the release key. Any failure removes the partial download and
 * leaves a previously staged package untouched.
 */
export async function stageUpdate(
  options: StageOptions,
): Promise<StagedUpdate> {
  const target = releaseTargetFor(options.manifest.target);
  if (target === undefined) {
    throw new UpdateDownloadError(
      `この構成 (${options.manifest.target}) 向けの更新は配布されていません`,
    );
  }
  const dir = stagingDir(options.installDir);
  const partPath = join(dir, `${STAGED_ARCHIVE_BASE}${PART_SUFFIX}`);
  const archivePath = stagedArchivePath(options.installDir, target.format);
  const doFetch = options.fetch ?? fetch;

  await Deno.mkdir(dir, { recursive: true });
  await Deno.remove(partPath).catch(() => {});

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout]);

  let received = 0;
  try {
    const response = await doFetch(options.manifest.url, {
      signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new UpdateDownloadError(
        `更新パッケージを取得できませんでした (HTTP ${response.status})`,
      );
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    const total = Number.isFinite(declared) && declared > 0
      ? declared
      : options.manifest.size;

    const file = await Deno.open(partPath, {
      create: true,
      write: true,
      truncate: true,
    });
    try {
      if (response.body === null) {
        throw new UpdateDownloadError("更新パッケージの本体が空です");
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > options.manifest.size) {
          await reader.cancel().catch(() => {});
          throw new UpdateDownloadError(
            "更新パッケージがマニフェストの想定サイズを超えています",
          );
        }
        let written = 0;
        while (written < value.length) {
          written += await file.write(value.subarray(written));
        }
        options.onProgress?.({ received, total });
      }
    } finally {
      file.close();
    }

    if (received !== options.manifest.size) {
      throw new UpdateDownloadError(
        `更新パッケージのサイズが一致しません (${
          received.toLocaleString("en-US")
        } / ${options.manifest.size.toLocaleString("en-US")} バイト)`,
      );
    }

    // Only a signed archive can become "staged": the verification decides
    // whether the file is kept at all.
    await verifyFileSignature({
      file: partPath,
      signature: options.manifest.signature,
      publicKey: options.publicKey,
    });
  } catch (error) {
    await Deno.remove(partPath).catch(() => {});
    if (error instanceof UpdateDownloadError) throw error;
    throw new UpdateDownloadError(
      `更新パッケージを取得できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The new package replaces any previous one only now that it is verified.
  await clearStagedPackage(options.installDir);
  await Deno.rename(partPath, archivePath);
  const staged: StagedUpdate = {
    version: options.manifest.version,
    target: options.manifest.target,
    url: options.manifest.url,
    signature: options.manifest.signature,
    size: options.manifest.size,
    format: target.format,
    stagedAt: new Date().toISOString(),
    archivePath,
  };
  await Deno.writeTextFile(
    join(dir, STAGED_METADATA_FILE),
    JSON.stringify(
      {
        version: staged.version,
        target: staged.target,
        url: staged.url,
        signature: staged.signature,
        size: staged.size,
        format: staged.format,
        stagedAt: staged.stagedAt,
      },
      null,
      2,
    ) + "\n",
  );
  return staged;
}
