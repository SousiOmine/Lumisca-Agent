/**
 * The machine's exec seams: the per-call `podman exec` argv for one agent's
 * container, in the shapes the backends ask for (text, bytes, the live channel
 * the scripting tool keeps open, and the screen variants).
 *
 * Every seam handed out here wakes the machine first, counts as use, and
 * counts as work in flight while it runs, so no backend has to remember to. The
 * screen seams also start the desktop: a screenshot or a click before the
 * window manager is up sees an empty screen.
 *
 * The argv carries the container's name and workdir and nothing else: the
 * container's own `DISPLAY` and session bus are inherited from the container,
 * because one container serves one agent. Which command runner is behind them
 * is the option the server passes (the tests pass a recorder instead of
 * podman).
 */

import { openVmChannel, type VmChannelRunner } from "./channel.ts";
import {
  runVmCommand,
  runVmCommandBytes,
  type VmCommandBytesRunner,
  type VmCommandRunner,
} from "./command.ts";
import type { VmChannelOpener, VmExec, VmExecBytes } from "./container.ts";
import {
  createVmChannel,
  createVmExec,
  createVmExecBytes,
} from "./container.ts";
import { vmContainerName } from "./contract.ts";

/** The command runners a machine was built with. The channel runner is
 * optional and falls back to the real one, which is the only runner the tests
 * never replace. */
export interface MachineRunners {
  run: VmCommandRunner;
  runBytes: VmCommandBytesRunner;
  openChannel?: VmChannelRunner;
}

/** What a seam does around the call it wraps: wake the machine, count the call
 * as use and as work in flight, and (for a screen seam) start the desktop. */
export interface SeamHooks {
  enter(agentId: string): void;
  leave(agentId: string): void;
  touch(agentId: string): void;
  wake(agentId: string): Promise<void>;
  ensureDesktop(agentId: string): Promise<void>;
}

export class MachineSeams {
  constructor(
    private readonly options: {
      /** Whether a host is attached at all (code mode has none). */
      hasHost: () => boolean;
      runners: MachineRunners | undefined;
      hooks: SeamHooks;
    },
  ) {}

  /** The text seam of one agent's machine, or undefined without a host. The
   * file tools, the shell and a background command take this one. */
  exec(agentId: string): VmExec | undefined {
    const base = this.#text(agentId);
    if (base === undefined) return undefined;
    return (command, exec) => this.#around(agentId, () => base(command, exec));
  }

  /** The byte variant of {@link exec} (a screen capture). */
  execBytes(agentId: string): VmExecBytes | undefined {
    const base = this.#bytes(agentId);
    if (base === undefined) return undefined;
    return (command, exec) => this.#around(agentId, () => base(command, exec));
  }

  /** The text seam a screen tool takes: the desktop is started first. */
  screenExec(agentId: string): VmExec | undefined {
    const base = this.#text(agentId);
    if (base === undefined) return undefined;
    return (command, exec) =>
      this.#around(agentId, () => base(command, exec), true);
  }

  /** The byte variant of {@link screenExec}. */
  screenExecBytes(agentId: string): VmExecBytes | undefined {
    const base = this.#bytes(agentId);
    if (base === undefined) return undefined;
    return (command, exec) =>
      this.#around(agentId, () => base(command, exec), true);
  }

  /** The interactive seam of one machine (the scripting tool call). It does
   * not start a desktop: it runs a program, not a screen action. */
  channel(agentId: string): VmChannelOpener | undefined {
    if (!this.options.hasHost()) return undefined;
    const base = this.#channel(agentId);
    return (command, exec) => this.#around(agentId, () => base(command, exec));
  }

  /** The text seam with nothing wrapped around it: the skill reads take this
   * one, because a catalog read must not start a container (see
   * machine-skills.ts). */
  execWithoutWake(agentId: string): VmExec | undefined {
    return this.#text(agentId);
  }

  #text(agentId: string): VmExec | undefined {
    if (!this.options.hasHost()) return undefined;
    return createVmExec({
      run: this.options.runners?.run ?? runVmCommand,
      containerName: vmContainerName(agentId),
    });
  }

  #bytes(agentId: string): VmExecBytes | undefined {
    if (!this.options.hasHost()) return undefined;
    return createVmExecBytes({
      runBytes: this.options.runners?.runBytes ?? runVmCommandBytes,
      containerName: vmContainerName(agentId),
    });
  }

  #channel(agentId: string): VmChannelOpener {
    return createVmChannel({
      open: this.options.runners?.openChannel ?? openVmChannel,
      containerName: vmContainerName(agentId),
    });
  }

  async #around<T>(
    agentId: string,
    call: () => Promise<T>,
    desktop = false,
  ): Promise<T> {
    const hooks = this.options.hooks;
    hooks.enter(agentId);
    try {
      hooks.touch(agentId);
      await hooks.wake(agentId);
      if (desktop) await hooks.ensureDesktop(agentId);
      return await call();
    } finally {
      hooks.leave(agentId);
    }
  }
}
