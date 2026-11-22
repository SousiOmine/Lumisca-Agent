/**
 * One agent's machine: its status cache, the start it decides through (create,
 * recreate or leave alone), and the small operations the backends ask for
 * (stop, remove, the screen's port, the desktop).
 *
 * The manager owns no truth about the container; it owns the CACHE of the
 * answer and the sequence of steps a start is made of. What exists and what
 * the container carries is asked of podman through the modules beside this one
 * (host status, the image, the lifecycle, the contract check), so a container
 * stopped by hand or removed with `podman rm` is noticed on the next read.
 */

import { CoreError, errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { VM_TEXT_OUTPUT_LIMIT, type VmCommandRunner } from "./command.ts";
import { limitsMismatch, readContainerFacts } from "./container-facts.ts";
import type { ContainerLifecycle } from "./container-lifecycle.ts";
import {
  VM_DESKTOP_SCRIPT,
  VM_STATUS_CACHE_MS,
  VM_STOP_TIMEOUT_MS,
  VM_WORKDIR,
  vmContainerName,
} from "./contract.ts";
import type { ContractChecker } from "./contract-check.ts";
import type { HostStatusProbe } from "./host-status.ts";
import type { ImageManager } from "./image.ts";
import { detail, execArgv } from "./podman.ts";
import type { VmManager, VmProgress, VmStatus } from "./types.ts";

/** Starting a desktop is a cold start of a window manager and a browser, not a
 * command: the first one builds a profile too. */
const VM_DESKTOP_TIMEOUT_MS = 120_000;

const log = createLogger("stella");

/** What one machine's manager is built from — the host's shared pieces. */
export interface MachineManagerOptions {
  run: VmCommandRunner;
  probe: HostStatusProbe;
  image: ImageManager;
  lifecycle: ContainerLifecycle;
  contract: ContractChecker;
  report: (progress: VmProgress) => void;
  /** Take the manager out of the host's map (an agent that was deleted). */
  forget: (agentId: string) => void;
  retireLegacy: () => Promise<void>;
}

export function createMachineManager(
  agentId: string,
  options: MachineManagerOptions,
): VmManager {
  const run = options.run;
  const name = vmContainerName(agentId);
  let machineCached: { at: number; status: VmStatus } | null = null;
  let machineInFlight: Promise<VmStatus> | undefined;

  async function status(readFresh = false): Promise<VmStatus> {
    const now = Date.now();
    if (
      !readFresh &&
      machineCached !== null &&
      now - machineCached.at < VM_STATUS_CACHE_MS
    ) {
      return machineCached.status;
    }
    if (machineInFlight !== undefined) return await machineInFlight;
    const read = (async () => {
      try {
        const result = await readStatus();
        machineCached = { at: Date.now(), status: result };
        return result;
      } finally {
        machineInFlight = undefined;
      }
    })();
    machineInFlight = read;
    return await read;
  }

  async function readStatus(): Promise<VmStatus> {
    const shared = await options.probe.read();
    if (shared.state !== "ready") {
      return {
        state: shared.state,
        vncPort: null,
        reason: shared.reason,
      };
    }
    const facts = await readContainerFacts(options.run, name);
    if (facts === undefined) {
      return { state: "container_missing", vncPort: null, reason: "" };
    }
    if (facts.agent !== agentId) {
      return {
        state: "stopped",
        vncPort: facts.vncPort,
        reason:
          facts.agent === ""
            ? "the machine has no agent label (it was not created by this " +
              "application)"
            : `the machine belongs to another agent (${facts.agent})`,
      };
    }
    if (facts.status !== "running") {
      return { state: "stopped", vncPort: null, reason: "" };
    }
    // Judged before the contract check, which costs a `podman exec`: this
    // answer came with the inspect above, and a machine without its ceilings
    // is replaced rather than asked to prove anything about itself.
    const limits = limitsMismatch(facts);
    if (limits !== null) {
      return { state: "stopped", vncPort: facts.vncPort, reason: limits };
    }
    // Running is not enough: the machine is usable when its own values match
    // the contract (verified once per instance, see contract-check.ts).
    const contract = await options.contract.check(facts, agentId);
    if (contract !== null) {
      return { state: "stopped", vncPort: facts.vncPort, reason: contract };
    }
    return { state: "running", vncPort: facts.vncPort, reason: "" };
  }

  return {
    status: (statusOptions) => status(statusOptions?.fresh === true),

    async start() {
      // The first machine of this installation takes the old single
      // container out of the way (its home is on the volume the new ones
      // mount). Done here rather than at attach: reading a status, running
      // a packaged smoke test or opening the settings must not stop the
      // machine a running installation is using. A failure is reported but
      // does not block the start — the new machine has its own home.
      try {
        await options.retireLegacy();
      } catch (error) {
        log.warn(
          `could not retire the old single machine: ${errorMessage(error)}`,
        );
      }
      const before = await status(true);
      switch (before.state) {
        case "podman_missing":
        case "podman_unusable":
          throw new CoreError(before.reason, "unavailable");
        case "running":
          return before;
        case "image_missing":
        case "image_stale":
          // The image is the host's: one build serves every machine. The
          // container this agent had was created from the old definition,
          // so it is replaced (a missing one is simply created).
          await options.image.ensure();
          await options.lifecycle.recreate(agentId);
          break;
        case "container_missing":
          await options.lifecycle.create(agentId);
          await options.lifecycle.start(name);
          break;
        case "stopped":
          if (before.reason !== "") {
            // The container exists but is broken (a drifted image, a dead
            // entry point, another agent's label). Recreating it is the only
            // way forward. The home is on the shared volume, so nothing the
            // agent wrote is lost by that.
            await options.lifecycle.recreate(agentId);
          } else {
            await options.lifecycle.start(name);
          }
          break;
      }
      options.report({ phase: "verifying" });
      await options.lifecycle.waitForScreen(name);
      machineCached = null;
      const after = await status(true);
      if (after.state !== "running") {
        throw new CoreError(
          after.reason !== ""
            ? after.reason
            : `the machine is not running (state: ${after.state})`,
          "unavailable",
        );
      }
      return after;
    },

    async stop() {
      // Stopping is idempotent: a machine that is already down (a second
      // sleep, a stop after a crash) is not an error, and `podman stop`
      // answers one in a single call without an existence check first.
      await options.lifecycle.stop(name);
      machineCached = null;
      options.contract.forget(agentId);
    },

    async remove() {
      if (await options.lifecycle.exists(name)) {
        await options.lifecycle.stop(name);
        await options.lifecycle.remove(name);
      }
      machineCached = null;
      options.contract.forget(agentId);
      options.forget(agentId);
    },

    async vncPort() {
      const current = await status(true);
      if (current.state !== "running") return null;
      return current.vncPort;
    },

    async startDesktop() {
      const result = await run(
        execArgv(name, [VM_DESKTOP_SCRIPT, "start", agentId], {
          workdir: VM_WORKDIR,
        }),
        { timeoutMs: VM_DESKTOP_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
      );
      if (result.exitCode !== 0) {
        throw new CoreError(
          `Could not start the agent's desktop: ${detail(result)}`,
          "unavailable",
        );
      }
    },

    async stopDesktop() {
      // A desktop that is already down is not an error: stopping is
      // idempotent, and the caller stops what it may no longer remember.
      await run(
        execArgv(name, [VM_DESKTOP_SCRIPT, "stop"], {
          workdir: VM_WORKDIR,
        }),
        { timeoutMs: VM_STOP_TIMEOUT_MS, maxOutput: VM_TEXT_OUTPUT_LIMIT },
      );
    },
  };
}
