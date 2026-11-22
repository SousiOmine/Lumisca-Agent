/**
 * The image every machine runs: which container files it was built from, the
 * build itself, and whether the image on disk still matches the files.
 *
 * The digest travels with the image as a label, so "is this the machine this
 * installation describes" is answered from the image alone rather than from a
 * record on our side that a hand-run build or a reset storage would falsify.
 * The build is shared: one image serves every agent, so concurrent callers
 * wait for the one build in flight instead of starting a second.
 */

import * as fsSync from "node:fs";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { concatBytes } from "../bytes.ts";
import { CoreError } from "../errors.ts";
import { VM_TEXT_OUTPUT_LIMIT, type VmCommandRunner } from "./command.ts";
import {
  VM_BUILD_TIMEOUT_MS,
  VM_CONTAINERFILE_NAME,
  VM_IMAGE_DIGEST_LABEL,
  VM_IMAGE_NAME,
} from "./contract.ts";
import type { HostStatusProbe } from "./host-status.ts";
import { detail, podman } from "./podman.ts";
import type { VmProgress } from "./types.ts";

/**
 * SHA-256 over every file in the directory the machine is built from, or null
 * when the directory cannot be read.
 *
 * The whole directory, not only the Containerfile: it COPYs entry.sh and the
 * accessibility helper, and a changed helper is as much a different machine as
 * a changed instruction. Subdirectories are walked too, and a file's path
 * relative to the directory goes in with the bytes, so adding, removing,
 * renaming or moving a file also changes the digest. Exported for the test
 * that proves an edit changes it.
 */
export async function containerFilesDigest(
  containerDir: string,
): Promise<string | null> {
  let files: { path: string; bytes: Uint8Array }[];
  try {
    files = await readContainerFiles(containerDir);
  } catch {
    return null;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(encoder.encode(`${file.path}\u0000`));
    parts.push(file.bytes);
    parts.push(encoder.encode("\u0000"));
  }
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(parts));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Every file under the container directory, keyed by its relative path with
 * "/" separators. */
async function readContainerFiles(
  dir: string,
  prefix = "",
): Promise<{ path: string; bytes: Uint8Array }[]> {
  const out: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(
        ...(await readContainerFiles(join(dir, entry.name), `${path}/`)),
      );
    } else if (entry.isFile()) {
      out.push({ path, bytes: await fsp.readFile(join(dir, entry.name)) });
    }
  }
  return out;
}

export interface ImageManager {
  /** Build the image when it is missing or stale, and do nothing when it is
   * current. Concurrent callers share one build. */
  ensure(): Promise<void>;
  /** Whether the image was built from files that have since changed. */
  isStale(): Promise<boolean>;
  /** Whether a build is in flight (the client says "preparing"). */
  readonly building: boolean;
}

export function createImageManager(options: {
  run: VmCommandRunner;
  /** The directory holding the machine's `Containerfile` and `entry.sh`. */
  containerDir: string;
  /** The host's verdict: a build is only started for a host whose podman
   * works, and the image's presence is part of that verdict. */
  probe: HostStatusProbe;
  report: (progress: VmProgress) => void;
}): ImageManager {
  const run = options.run;
  const containerfilePath = join(options.containerDir, VM_CONTAINERFILE_NAME);
  /** The digest recorded in the image's label, or null when the image has no
   * usable record (built before the label existed, which counts as stale). */
  let imageDigestCache: { value: string | null } | undefined;
  /** The in-flight image build, shared by every machine that asks for one. */
  let buildInFlight: Promise<void> | undefined;

  /** The digest of the container files as they are on disk now, or null when
   * they cannot be read (a deployment that lost them: the image on disk is
   * then the only definition and must not be rebuilt from nothing). */
  const containerDigest = () => containerFilesDigest(options.containerDir);

  /** The digest recorded in the image's label, or null when the image has no
   * usable record.
   *
   * The answer is kept for the life of this host: a label only changes when
   * the image is rebuilt, and a rebuild is something this host does itself
   * (see buildImage, which forgets the cached value). Asking podman again on
   * every status read was a process spawn per poll for an answer that could
   * not have moved. */
  async function imageDigest(): Promise<string | null> {
    if (imageDigestCache !== undefined) return imageDigestCache.value;
    const result = await run(
      podman([
        "image",
        "inspect",
        "--format",
        `{{ index .Labels "${VM_IMAGE_DIGEST_LABEL}" }}`,
        VM_IMAGE_NAME,
      ]),
      { timeoutMs: 30_000, maxOutput: 4096 },
    );
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    const digest = value === "" || value === "<no value>" ? null : value;
    imageDigestCache = { value: digest };
    return digest;
  }

  /** Whether the image still matches the container files on disk. Unknown
   * files (a deployment without them) leave the image alone: there is nothing
   * to rebuild from.
   *
   * The files' digest is read from disk on every check, and the label from
   * podman: they are compared together, so neither can be reused alone. */
  async function isStale(): Promise<boolean> {
    const wanted = await containerDigest();
    if (wanted === null) return false;
    return (await imageDigest()) !== wanted;
  }

  async function buildImage(): Promise<void> {
    if (!existsSync(containerfilePath)) {
      throw new CoreError(
        `The machine's image definition is missing: ${containerfilePath}`,
        "unavailable",
      );
    }
    const digest = await containerDigest();
    options.report({ phase: "building_image" });
    const result = await run(
      podman([
        "build",
        "--tag",
        VM_IMAGE_NAME,
        // The definition's digest travels with the image, so the next start
        // can tell whether the image still matches the files on disk.
        ...(digest === null
          ? []
          : ["--label", `${VM_IMAGE_DIGEST_LABEL}=${digest}`]),
        "--file",
        containerfilePath,
        options.containerDir,
      ]),
      { timeoutMs: VM_BUILD_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
    );
    if (result.exitCode !== 0) {
      throw new CoreError(
        `Could not build the machine's image: ${detail(result)}`,
        "unavailable",
      );
    }
    // The image the label belonged to is gone: the next read must ask again
    // rather than compare against the build that was just replaced.
    imageDigestCache = undefined;
    options.probe.noteImageBuilt();
  }

  async function ensure(): Promise<void> {
    if (buildInFlight !== undefined) return await buildInFlight;
    const state = await options.probe.read(true);
    switch (state.state) {
      case "podman_missing":
      case "podman_unusable":
        throw new CoreError(state.reason, "unavailable");
      case "image_missing":
      case "image_stale": {
        const build = buildImage().finally(() => {
          buildInFlight = undefined;
        });
        buildInFlight = build;
        await build;
        return;
      }
      case "ready":
        return;
    }
  }

  return {
    ensure,
    isStale,
    get building() {
      return buildInFlight !== undefined;
    },
  };
}
