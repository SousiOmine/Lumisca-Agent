/**
 * The stella virtual machine: a podman container the agent works inside.
 *
 * One container per stella agent. This file is the assembly: it builds the
 * parts a machine is made of and hands them to each other — the host status
 * probe (podman presence, usability, the image's presence), the image manager
 * (digest, build, staleness), the container lifecycle (create/start/stop/
 * remove/recreate and the legacy retirement), the contract verifier (the
 * values inside the running container) and one manager per agent (its status
 * cache and the steps a start is made of).
 *
 * Only the container's own existence and health are managed here — what the
 * agent does with it (files, shell, screen) lives in the backends that sit on
 * top (vm/fs.ts, vm/shell.ts, vm/screen.ts). State is decided by asking
 * podman every time rather than by a ledger on our side: a container stopped
 * by hand, or removed with `podman rm`, must not leave this application
 * believing the machine is up.
 */

import type {
  VmChannel,
  VmChannelOptions,
  VmChannelRunner,
} from "./channel.ts";
import {
  runVmCommand,
  type VmCommandBytesResult,
  type VmCommandBytesRunner,
  type VmCommandOptions,
  type VmCommandResult,
  type VmCommandRunner,
} from "./command.ts";
import { createContainerLifecycle } from "./container-lifecycle.ts";
import { VM_WORKDIR } from "./contract.ts";
import { createContractChecker } from "./contract-check.ts";
import { createHostStatusProbe } from "./host-status.ts";
import { createImageManager } from "./image.ts";
import { createMachineManager } from "./machine-manager.ts";
import { podman } from "./podman.ts";
import type { VmHost, VmHostOptions, VmManager, VmProgress } from "./types.ts";

export { containerFilesDigest } from "./image.ts";
export type {
  VmHost,
  VmHostOptions,
  VmHostState,
  VmHostStatus,
  VmManager,
  VmProgress,
  VmState,
  VmStatus,
} from "./types.ts";

export function createVmHost(options: VmHostOptions): VmHost {
  const run = options.run ?? runVmCommand;
  const report = (progress: VmProgress) => options.onProgress?.(progress);

  // The two share one question each way — the probe asks whether the image
  // still matches the files, the image asks for the verdict before it builds —
  // and neither answer is the other's: the probe is made first because the
  // image needs it, so the staleness question is handed over as a callback
  // that only runs when a read gets that far.
  const probe = createHostStatusProbe({
    run,
    isImageStale: () => image.isStale(),
  });
  const image = createImageManager({
    run,
    containerDir: options.containerDir,
    probe,
    report,
  });
  const contract = createContractChecker({ run });
  const lifecycle = createContainerLifecycle({ run, image, report });

  /** One manager per agent, so a status cache and a contract pass belong to
   * the container they were made about. */
  const machines = new Map<string, VmManager>();

  const machineFor = (agentId: string): VmManager => {
    const known = machines.get(agentId);
    if (known !== undefined) return known;
    const machine = createMachineManager(agentId, {
      run,
      probe,
      image,
      lifecycle,
      contract,
      report,
      forget: (id) => machines.delete(id),
      retireLegacy: () => lifecycle.retireLegacy(),
    });
    machines.set(agentId, machine);
    return machine;
  };

  return {
    status: (statusOptions) => probe.read(statusOptions?.fresh === true),
    ensureImage: () => image.ensure(),
    get building() {
      return image.building;
    },
    machine: machineFor,
    async stopAll() {
      // The machines this process knows about: the ones it started, or the
      // ones it found running when a conversation asked. A machine nobody
      // touched here is left alone — another installation on the same podman
      // may be using it — and a machine a crashed server left keeps running
      // until its agent is used again, when this process adopts it (the
      // container name is the agent's, so there is nothing to tell them
      // apart).
      let failure: Error | undefined;
      for (const [agentId, manager] of [...machines]) {
        try {
          await manager.stop();
          machines.delete(agentId);
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      probe.invalidate();
      contract.clear();
      if (failure !== undefined) throw failure;
    },
    retireLegacy: () => lifecycle.retireLegacy(),
  };
}

/** Run a command inside the machine (the entry point every backend uses). */
export type VmExec = (
  command: readonly string[],
  options: VmExecOptions,
) => Promise<VmExecResult>;

/** The same seam for a command whose output is binary (a screen capture). */
export type VmExecBytes = (
  command: readonly string[],
  options: VmExecOptions,
) => Promise<VmExecBytesResult>;

export type VmExecBytesResult = VmCommandBytesResult;

export interface VmExecOptions {
  workdir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: Uint8Array | AsyncIterable<Uint8Array>;
  maxOutput?: number;
  keep?: "head" | "tail";
  /** Environment variables for this call only (`podman exec --env`). */
  env?: Record<string, string>;
}

export type VmExecResult = VmCommandResult;

export type { VmCommandBytesResult };

/** The `podman exec` argv for one call. Both seams build the same command;
 * only how its output comes back (text or bytes) differs. */
function execArgv(
  container: string,
  command: readonly string[],
  exec: VmExecOptions,
): string[] {
  return podman([
    "exec",
    ...(exec.stdin === undefined ? [] : ["--interactive"]),
    ...Object.entries(exec.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--workdir",
    exec.workdir ?? VM_WORKDIR,
    container,
    ...command,
  ]);
}

/** The per-call options both seams pass through. */
function execOptions(exec: VmExecOptions): VmCommandOptions {
  return {
    timeoutMs: exec.timeoutMs,
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    ...(exec.stdin !== undefined ? { stdin: exec.stdin } : {}),
    ...(exec.maxOutput !== undefined ? { maxOutput: exec.maxOutput } : {}),
    ...(exec.keep !== undefined ? { keep: exec.keep } : {}),
  };
}

/** Run a command inside one machine, with the container's name and workdir
 * already applied. This is the seam the file/shell/screen backends use; it
 * exists so none of them has to know podman's argument shape. */
export function createVmExec(options: {
  run: VmCommandRunner;
  containerName: string;
}): VmExec {
  return (command, exec) =>
    options.run(
      execArgv(options.containerName, command, exec),
      execOptions(exec),
    );
}

/** The byte variant of {@link createVmExec}: the same argument shape, with
 * the output kept as raw bytes (a PNG must not be decoded as text). */
export function createVmExecBytes(options: {
  runBytes: VmCommandBytesRunner;
  containerName: string;
}): VmExecBytes {
  return (command, exec) =>
    options.runBytes(
      execArgv(options.containerName, command, exec),
      execOptions(exec),
    );
}

/** Options of one interactive exec: a channel to a program inside the
 * machine, with the container's name and workdir already applied. */
export interface VmChannelExecOptions extends VmChannelOptions {
  workdir?: string;
  env?: Record<string, string>;
}

/** Opens an interactive exec in the machine (see vm/channel.ts). */
export type VmChannelOpener = (
  command: readonly string[],
  options: VmChannelExecOptions,
) => Promise<VmChannel>;

/** The argv of one interactive exec: always `--interactive`, because the
 * channel writes to the program's stdin. */
function channelArgv(
  container: string,
  command: readonly string[],
  options: VmChannelExecOptions,
): string[] {
  return podman([
    "exec",
    "--interactive",
    ...Object.entries(options.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--workdir",
    options.workdir ?? VM_WORKDIR,
    container,
    ...command,
  ]);
}

/** Open an interactive exec, with the container's name and workdir already
 * applied. The scripting tool call's seam: the only caller that needs the
 * exchange to stay live (see vm/channel.ts). */
export function createVmChannel(options: {
  open: VmChannelRunner;
  containerName: string;
}): VmChannelOpener {
  return (command, exec) =>
    options.open(channelArgv(options.containerName, command, exec), {
      timeoutMs: exec.timeoutMs,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      ...(exec.maxStderrChars !== undefined
        ? { maxStderrChars: exec.maxStderrChars }
        : {}),
    });
}
