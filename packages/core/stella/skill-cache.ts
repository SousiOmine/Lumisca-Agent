import type { VmManager } from "../vm/container.ts";

/** How long a stella skill catalog stays usable for opening a conversation. */
export const STELLA_SKILLS_TTL_MS = 30_000;

interface Entry {
  /** The machine that answered the last read: a replaced machine has a
   * replaced catalog, so its entry is not reused. */
  machine: VmManager | undefined;
  /** When the last read finished (0 = never). */
  at: number;
  /** The read in flight, shared by concurrent opens of the same agent. */
  pending: Promise<void> | undefined;
}

/**
 * The skill catalog of each stella agent, as last read from the machine.
 *
 * A catalog read crosses into the machine (`podman exec`), and a
 * conversation opened from a phone over a slow link must not wait for a list
 * that has not changed. Opening a conversation therefore re-reads a list
 * only when it is cold or older than the TTL, and concurrent opens of the
 * same agent share one read.
 *
 * Keyed by agent id: an agent's own skills live in its folder, so every
 * agent has its own list (only the machine-wide folder is shared). The read
 * itself is the caller's: this class owns the timing, not the command.
 */
export class StellaSkillCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = STELLA_SKILLS_TTL_MS) {}

  /** Read one agent's catalog now and remember when, for which machine. */
  async refresh(
    agentId: string,
    machine: VmManager | undefined,
    read: () => Promise<void>,
  ): Promise<void> {
    await read();
    this.entries.set(agentId, { machine, at: Date.now(), pending: undefined });
  }

  /** Make one agent's catalog current enough to open its conversation.
   * A read in flight is awaited, a fresh one is reused, and a cold or stale
   * one starts (and is shared by everyone waiting). */
  async prime(
    agentId: string,
    machine: VmManager | undefined,
    read: () => Promise<void>,
  ): Promise<void> {
    let entry = this.entries.get(agentId);
    if (entry === undefined || entry.machine !== machine) {
      entry = { machine, at: 0, pending: undefined };
      this.entries.set(agentId, entry);
    }
    if (entry.pending !== undefined) {
      await entry.pending;
      return;
    }
    if (entry.at !== 0 && Date.now() - entry.at < this.ttlMs) return;
    const pending = this.refresh(agentId, machine, read);
    entry.pending = pending;
    await pending;
  }

  /** Drop one agent's entry (the agent was deleted). */
  forget(agentId: string): void {
    this.entries.delete(agentId);
  }
}
