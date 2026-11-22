/**
 * Whether this host can run a machine at all, and whether its image is there
 * and current.
 *
 * The answer is one verdict (`VmHostStatus`) built from three questions asked
 * of podman in the cheapest order: is it installed, can it start a container
 * here, is the image built and built from the files on disk. What may be
 * remembered is decided here alone — a success is, a failure is not — because
 * the client polls this while it watches stella mode and every `podman` call
 * is a process spawn the person waits through.
 */

import { firstLine } from "../lines.ts";
import type { VmCommandRunner } from "./command.ts";
import {
  VM_IMAGE_NAME,
  VM_PROBE_IMAGE,
  VM_STATUS_CACHE_MS,
} from "./contract.ts";
import { podman } from "./podman.ts";
import type { VmHostStatus } from "./types.ts";

/**
 * What this host has already proven, and how the verdict is read.
 *
 * `read` is the only way in: it shares one in-flight round of podman calls
 * between concurrent callers and keeps the last verdict for
 * VM_STATUS_CACHE_MS. The two notifiers exist because whoever changed the
 * state knows it: a build makes an image exist, and an operation on a machine
 * voids a verdict that was made before it.
 */
export interface HostStatusProbe {
  read(fresh?: boolean): Promise<VmHostStatus>;
  /** Record that the image now exists and drop the cached verdict. */
  noteImageBuilt(): void;
  /** Drop the cached verdict after an operation changed the state. */
  invalidate(): void;
}

export function createHostStatusProbe(options: {
  run: VmCommandRunner;
  /** Whether the image still matches the container files on disk (the image
   * manager owns that answer, and the build that changes it). */
  isImageStale: () => Promise<boolean>;
}): HostStatusProbe {
  const run = options.run;

  /** Whether `podman --version` has answered successfully. Its answer cannot
   * change while the process runs, and asking it on every status read was one
   * spawn of the three a poll used to cost. A failure is not remembered (see
   * readHostStatus): installing podman must take effect without a restart. */
  let podmanPresent = false;
  /** Whether this host has proven it can actually start a container (see
   * readHostStatus). Undefined until asked; a host that cannot is not asked
   * again on every poll. */
  let runtimeUsable: boolean | undefined;
  /** Whether a usable image was seen by the last status read, so the next one
   * can skip asking podman again. Undefined until a read has answered: a
   * known-absent image is not retried, but a fresh host always asks. */
  let imagePresent: boolean | undefined;
  /** The last host verdict, cached for VM_STATUS_CACHE_MS. */
  let cached: { at: number; status: VmHostStatus } | null = null;
  /** The in-flight host read. Concurrent callers (a poll, several machines
   * starting at once) wait for the same podman calls. */
  let inFlight: Promise<VmHostStatus> | undefined;

  async function read(readFresh = false): Promise<VmHostStatus> {
    const now = Date.now();
    if (!readFresh && cached !== null && now - cached.at < VM_STATUS_CACHE_MS) {
      return cached.status;
    }
    if (inFlight !== undefined) return await inFlight;
    const pending = (async () => {
      try {
        const result = await readHostStatus();
        cached = { at: Date.now(), status: result };
        return result;
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = pending;
    return await pending;
  }

  async function readHostStatus(): Promise<VmHostStatus> {
    // `podman --version` is the cheapest proof that podman exists and runs as
    // this user (a rootless setup that is not configured fails here too). A
    // SUCCESS is remembered — podman does not uninstall itself mid-run, and
    // every `podman` call is a spawn the watching client waits through — while
    // a failure is asked again on the next read, because installing podman
    // must take effect without a restart. It is not inferred from a failed
    // inspect: guessing "podman is missing" out of an error message would
    // report a broken installation as an uninstalled one.
    if (!podmanPresent) {
      const version = await run(podman(["--version"]), {
        timeoutMs: 15_000,
        maxOutput: 4096,
      });
      if (version.exitCode !== 0) {
        return {
          state: "podman_missing",
          reason: `podman is not available: ${firstLine(version.stderr)}`,
        };
      }
      podmanPresent = true;
    }
    // podman answering says nothing about whether a container can run here:
    // inside a container that is itself sandboxed, `podman --version` is fine
    // and every start fails at the runtime with a kernel path it may not
    // write. The answer is asked once, cheaply, before the mode is offered —
    // the alternative is what this replaced: the mode offered, an image
    // build minutes long, and a failure whose message names /proc/sys.
    if (!runtimeUsable) {
      const probe = await run(
        podman(["run", "--rm", "--network=none", VM_PROBE_IMAGE, "true"]),
        { timeoutMs: 120_000, maxOutput: 8192 },
      );
      if (probe.exitCode !== 0) {
        return {
          state: "podman_unusable",
          reason: firstLine(probe.stderr) || `exit code ${probe.exitCode}`,
        };
      }
      runtimeUsable = true;
    }
    // `image exists` is the expensive half of a cold check and the answer only
    // changes when the image is built (which the caller does itself) or
    // removed by hand. Once an image has been seen it is not asked about
    // again; a container created from it cannot outlive its removal without
    // the machine's own `podman container inspect` reporting it.
    if (imagePresent !== true) {
      const image = await run(podman(["image", "exists", VM_IMAGE_NAME]), {
        timeoutMs: 30_000,
      });
      if (image.exitCode !== 0) {
        imagePresent = false;
        return { state: "image_missing", reason: "" };
      }
      imagePresent = true;
    }
    // An image built from older container files (the Containerfile was edited,
    // or a release shipped a new one) is not the machine this installation
    // describes. It is judged before the container, because a machine still
    // running on it must be replaced rather than reported as healthy.
    if (await options.isImageStale()) {
      return { state: "image_stale", reason: "" };
    }
    return { state: "ready", reason: "" };
  }

  return {
    read,
    noteImageBuilt() {
      imagePresent = true;
      cached = null;
    },
    invalidate() {
      cached = null;
    },
  };
}
