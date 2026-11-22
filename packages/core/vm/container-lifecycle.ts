/**
 * The container's own existence: creating, starting, stopping and removing
 * one agent's machine, and retiring the single container the per-agent ones
 * replaced.
 *
 * Nothing here keeps a state of its own beyond the retirement in flight. What
 * exists is asked of podman at the call that needs it, because a container
 * stopped by hand or removed with `podman rm` must not leave this application
 * believing otherwise.
 */

import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { basename, join } from "node:path";
import { CoreError } from "../errors.ts";
import { firstLine } from "../lines.ts";
import { sleep } from "../shared/misc.ts";
import { VM_TEXT_OUTPUT_LIMIT, type VmCommandRunner } from "./command.ts";
import {
  VM_AGENT_LABEL,
  VM_COPY_TIMEOUT_MS,
  VM_GID,
  VM_HOME_VOLUME,
  VM_IMAGE_NAME,
  VM_LEGACY_CONTAINER_NAME,
  VM_MANAGED_LABEL,
  VM_MEMORY_LIMIT_BYTES,
  VM_MEMORY_SWAP_BYTES,
  VM_PIDS_LIMIT,
  VM_REMOVE_TIMEOUT_MS,
  VM_RUN_TIMEOUT_MS,
  VM_STOP_TIMEOUT_MS,
  VM_UID,
  VM_VNC_PORT,
  VM_WORKDIR,
  vmCacheHomeOf,
  vmContainerName,
} from "./contract.ts";
import type { ImageManager } from "./image.ts";
import { detail, podman, podmanExec } from "./podman.ts";
import type { VmProgress } from "./types.ts";

export interface ContainerLifecycle {
  create(agentId: string): Promise<void>;
  start(name: string): Promise<void>;
  /** Stop, remove and create it again from the current image, keeping the
   * home volume. */
  recreate(agentId: string): Promise<void>;
  /** Whether the container exists at all (a non-zero exit answers no). */
  exists(name: string): Promise<boolean>;
  /** `podman stop`: idempotent, and a machine that is already gone is not an
   * error. */
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Whether the container's entry point has finished bringing the screen
   * up. */
  waitForScreen(name: string): Promise<void>;
  /** Remove the single container the per-agent machines replaced (see the
   * comment on the function for when and why). */
  retireLegacy(): Promise<void>;
}

export function createContainerLifecycle(options: {
  run: VmCommandRunner;
  image: ImageManager;
  report: (progress: VmProgress) => void;
}): ContainerLifecycle {
  const run = options.run;

  async function containerExists(name: string): Promise<boolean> {
    const present = await run(podman(["container", "exists", name]), {
      timeoutMs: 30_000,
    });
    return present.exitCode === 0;
  }

  async function stopContainer(name: string): Promise<void> {
    await run(podman(["stop", "--time", "5", name]), {
      timeoutMs: VM_STOP_TIMEOUT_MS,
      maxOutput: VM_TEXT_OUTPUT_LIMIT,
    });
  }

  async function removeContainer(name: string): Promise<void> {
    const removed = await run(podman(["rm", "--force", name]), {
      timeoutMs: VM_REMOVE_TIMEOUT_MS,
    });
    if (removed.exitCode !== 0) {
      throw new CoreError(
        `Could not replace the machine: ${detail(removed)}`,
        "unavailable",
      );
    }
  }

  /** Create one agent's container from the image, without starting it. */
  async function createContainer(agentId: string): Promise<void> {
    options.report({ phase: "creating_container" });
    const name = vmContainerName(agentId);
    const result = await run(
      podman([
        "create",
        "--name",
        name,
        "--label",
        VM_MANAGED_LABEL,
        // The agent this machine serves. Read back with the container's facts
        // and compared before anything runs inside it, so a container renamed
        // or reused by hand is replaced instead of being driven as somebody
        // else's machine.
        "--label",
        `${VM_AGENT_LABEL}=${agentId}`,
        // A machine that dies by itself (a crashed X server, a browser the
        // kernel killed) has to come back without anyone asking: nothing
        // polls the container, and the only paths that start it are a prompt,
        // a tool call and the screen. `unless-stopped` is the one policy that
        // does not resurrect a machine `podman stop` ended on purpose — that
        // is how idle sleep and the app's own shutdown keep it down.
        "--restart",
        "unless-stopped",
        // Ceilings on what the machine may consume. They put the failure
        // inside the machine: a runaway browser or build is OOM-killed or
        // refused a process there, where the agent sees the error, instead of
        // taking memory or process slots the host's own programs need. The
        // values and why they are those numbers are in contract.ts.
        "--memory",
        String(VM_MEMORY_LIMIT_BYTES),
        "--memory-swap",
        String(VM_MEMORY_SWAP_BYTES),
        "--pids-limit",
        String(VM_PIDS_LIMIT),
        // The container's uid 1000 is mapped onto this host user, so files
        // the agent writes inside are this user's own — and files it must not
        // touch (the host's) are not reachable at all, because nothing is
        // mounted from the host.
        "--userns",
        `keep-id:uid=${VM_UID},gid=${VM_GID}`,
        // The screen bridge, on the host's loopback only. The host port is
        // assigned at creation and read back by `vncPort`.
        "--publish",
        `127.0.0.1::${VM_VNC_PORT}`,
        // The agent's home lives on a named volume, not in the container's
        // own writable layer: the container is recreated by a release, by a
        // sleep it did not survive, or by deleting the agent, and the files
        // the agent wrote must not go with it. Every machine mounts the same
        // volume, so the home is one home (see VM_HOME_VOLUME).
        "--volume",
        `${VM_HOME_VOLUME}:${VM_WORKDIR}`,
        // The cache AT-SPI and Chromium write. It is per agent because the
        // display it is keyed by is the same in every machine and the home is
        // shared (see vmCacheHomeOf).
        "--env",
        `XDG_CACHE_HOME=${vmCacheHomeOf(agentId)}`,
        VM_IMAGE_NAME,
      ]),
      { timeoutMs: VM_RUN_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
    );
    if (result.exitCode !== 0) {
      throw new CoreError(
        `Could not create the machine: ${detail(result)}`,
        "unavailable",
      );
    }
  }

  /** Replace one agent's container, keeping its home volume. */
  async function recreateContainer(agentId: string): Promise<void> {
    const name = vmContainerName(agentId);
    // Stopping first, not removing: `podman rm` on a running container would
    // be `--force` (a kill), and the volume's files are written by processes
    // the machine is still running.
    if (await containerExists(name)) {
      await stopContainer(name);
      await removeContainer(name);
    }
    await createContainer(agentId);
    await startContainer(name);
  }

  async function startContainer(name: string): Promise<void> {
    options.report({ phase: "starting_container" });
    const result = await run(podman(["start", name]), {
      timeoutMs: VM_RUN_TIMEOUT_MS,
      maxOutput: VM_TEXT_OUTPUT_LIMIT,
    });
    if (result.exitCode !== 0) {
      throw new CoreError(
        `Could not start the machine: ${detail(result)}`,
        "unavailable",
      );
    }
  }

  /** Whether the container's entry point has finished bringing the screen up.
   * A freshly started container needs a moment; without this the first status
   * check after start would report "stopped" because the screen is not
   * answering yet. */
  async function waitForScreen(name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const probe = await run(
        podmanExec(name, ["xdotool", "getdisplaygeometry"]),
        { timeoutMs: 15_000, maxOutput: 4096 },
      );
      if (probe.exitCode === 0) return;
      if (Date.now() >= deadline) {
        throw new CoreError(
          `The machine started but its screen did not come up: ${firstLine(
            probe.stderr,
          )}`,
          "unavailable",
        );
      }
      await sleep(300);
    }
  }

  /** Whether an existing container mounts the home volume. A container
   * created before the volume existed keeps its home in its own writable
   * layer; retiring it without carrying the files out would lose everything
   * the agent wrote. */
  async function mountsHomeVolume(name: string): Promise<boolean> {
    const result = await run(
      podman([
        "container",
        "inspect",
        "--format",
        "{{range .Mounts}}{{.Destination}}={{.Type}} {{end}}",
        name,
      ]),
      { timeoutMs: 30_000, maxOutput: 8192 },
    );
    if (result.exitCode !== 0) return true;
    return result.stdout.includes(`${VM_WORKDIR}=volume`);
  }

  /** Carry the home out of the legacy container and into the shared volume.
   *
   * Only an installation older than the volume needs this. The old container
   * is stopped, its home is read out, and a throw-away container mounts both
   * the volume and the saved copy to move the files across. A failure keeps
   * the saved copy and names its path: replacing the container would throw
   * the agent's work away, and a machine that starts empty after an update is
   * the failure this exists to prevent. */
  async function copyLegacyHomeToVolume(): Promise<void> {
    await options.image.ensure();
    const saved = await fsp.mkdtemp(join(osTmpdir(), "lumisca-stella-legacy-"));
    let moved = false;
    try {
      await stopContainer(VM_LEGACY_CONTAINER_NAME);
      const copyOut = await run(
        podman(["cp", `${VM_LEGACY_CONTAINER_NAME}:${VM_WORKDIR}`, saved]),
        { timeoutMs: VM_COPY_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
      );
      if (copyOut.exitCode !== 0) {
        throw new CoreError(
          `Could not read the old machine's files to move them onto its new ` +
            `home: ${detail(copyOut)}`,
          "unavailable",
        );
      }
      const moved_in = await run(
        podman([
          "run",
          "--rm",
          "--userns",
          `keep-id:uid=${VM_UID},gid=${VM_GID}`,
          "--volume",
          `${VM_HOME_VOLUME}:${VM_WORKDIR}`,
          "--volume",
          `${saved}:/lumisca-legacy:ro`,
          VM_IMAGE_NAME,
          "sh",
          "-c",
          `cp -a /lumisca-legacy/${basename(VM_WORKDIR)}/. ${VM_WORKDIR}/`,
        ]),
        { timeoutMs: VM_COPY_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
      );
      if (moved_in.exitCode !== 0) {
        throw new CoreError(
          `The old machine's files were read but could not be put back ` +
            `(they are kept in ${saved}): ${detail(moved_in)}`,
          "unavailable",
        );
      }
      moved = true;
    } finally {
      if (moved) await fsp.rm(saved, { recursive: true }).catch(() => {});
    }
  }

  /** The retirement in flight (or finished). */
  let retiring: Promise<void> | undefined;

  /**
   * Remove the single container the per-agent machines replaced.
   *
   * Done at the FIRST machine start, not when the host is attached: an app
   * that only reads a status, a packaged smoke test or a script has no
   * business stopping the machine a running installation is using. A failure
   * is not memoized — the files may still be on the old container, so the
   * next start tries again — and it does not stop the new machine from
   * starting: the home is on the shared volume either way.
   */
  function retireLegacy(): Promise<void> {
    retiring ??= (async () => {
      if (!(await containerExists(VM_LEGACY_CONTAINER_NAME))) return;
      if (!(await mountsHomeVolume(VM_LEGACY_CONTAINER_NAME))) {
        await copyLegacyHomeToVolume();
      } else {
        await stopContainer(VM_LEGACY_CONTAINER_NAME);
      }
      await removeContainer(VM_LEGACY_CONTAINER_NAME);
    })().catch((error) => {
      retiring = undefined;
      throw error;
    });
    return retiring;
  }

  return {
    create: createContainer,
    start: startContainer,
    exists: containerExists,
    recreate: recreateContainer,
    stop: stopContainer,
    remove: removeContainer,
    waitForScreen,
    retireLegacy,
  };
}
