import type { ComputerHost, ComputerHostResult } from "../computer/types.ts";
import { CoreError } from "../errors.ts";
import { COMPUTER_USE_ENABLED_KEY } from "../shared/settings-keys.ts";

/** What the service needs from the core it belongs to. Narrow on purpose:
 * the setting store and the one operation that makes open sessions follow a
 * capability change. */
export interface ComputerUseDeps {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  /** Apply a capability change to every open session (idle ones are rebuilt,
   * streaming ones have their tools reseeded in place). */
  applyCapabilityChange(mutate: () => void): void;
}

/**
 * This machine's screen, mouse and keyboard, as the agent may use them.
 *
 * Two facts are kept apart on purpose. Whether the machine HAS a host is a
 * verdict about this moment: a server started by systemd runs before the
 * desktop session does, so "no host" can be stale. Whether the user ENABLED
 * the feature is a stored setting. A session may drive the machine only when
 * both hold (see {@link hostForSession}).
 */
export class ComputerUseService {
  private host: ComputerHost | undefined;
  /** Why there is no host, as last observed (what the settings toggle
   * reports when a recheck still finds nothing). */
  private unavailableReason: string | undefined;
  private probe: (() => Promise<ComputerHostResult>) | undefined;

  constructor(private readonly deps: ComputerUseDeps) {}

  /** Adopt a startup or recheck verdict. */
  setHost(result: ComputerHostResult): void {
    this.host = result.available ? result.host : undefined;
    this.unavailableReason = result.available ? undefined : result.reason;
  }

  /** Set how to ask this machine again (the server owns the platform probe). */
  setProbe(probe: () => Promise<ComputerHostResult>): void {
    this.probe = probe;
  }

  /** Ask again whether this machine can be driven, replacing the startup
   * verdict. Without a probe the startup verdict is final, which keeps a
   * recheck from silently succeeding on a machine nobody looked at. */
  async recheck(): Promise<ComputerHostResult> {
    const probe = this.probe;
    if (probe === undefined) {
      const host = this.host;
      return host === undefined
        ? {
          available: false,
          reason: this.unavailableReason ??
            "computer use is not available on this machine",
        }
        : { available: true, host };
    }
    const result = await probe();
    if (!result.available) {
      this.unavailableReason = result.reason;
      return result;
    }
    // A host from the startup verdict is kept: it is the same machine, and
    // replacing it would drop a screen-sharing session the agent may be
    // using. A machine that only became drivable now gets the new host.
    const current = this.host;
    if (current === undefined) {
      this.setHost(result);
    } else if (result.host !== current) {
      result.host.close();
    }
    const adopted = this.host;
    return adopted === undefined ? result : { available: true, host: adopted };
  }

  /** The host this machine has, regardless of the user's toggle. */
  getHost(): ComputerHost | undefined {
    return this.host;
  }

  /** Whether the user enabled computer use ("1" = on; unset and anything
   * else are off, because a run can click and type anywhere). */
  isEnabled(): boolean {
    return this.deps.getSetting(COMPUTER_USE_ENABLED_KEY) === "1";
  }

  /** Enable or disable the feature and make the open sessions follow it.
   * Enabling on a machine without a host throws `unavailable` with the
   * machine's own reason: accepting it would advertise tools that cannot
   * run. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      const verdict = await this.recheck();
      if (!verdict.available) {
        throw new CoreError(verdict.reason, "unavailable");
      }
    }
    this.deps.applyCapabilityChange(() => {
      this.deps.setSetting(COMPUTER_USE_ENABLED_KEY, enabled ? "1" : "");
    });
  }

  /** The host a session may drive: attached only when this machine has one
   * AND the user enabled the feature. Read at agent open and at every tool
   * call, so disabling stops an already-seeded session on its next call. */
  hostForSession(): ComputerHost | undefined {
    return this.isEnabled() ? this.host : undefined;
  }
}
