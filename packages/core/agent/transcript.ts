import type { AgentMessage } from "../ai/types.ts";
import type { MessageRepo } from "../session/messages.ts";
import { messageIdentityOf } from "../session/transcript-window.ts";
import type { RemovedMessage } from "./rewinder.ts";

/**
 * The persisted part of a session's transcript, and where it sits in the
 * whole one.
 *
 * The agent holds the MODEL's view in memory: the newest compaction
 * checkpoint onward (see MessageRepo.listModelView). That view starts at a
 * position in the transcript, and every operation the store performs —
 * appending the tail, splicing a checkpoint in, dropping a suffix — takes a
 * position in the WHOLE transcript. `base` is the translation between the
 * two, and this type exists so no caller has to compute it: a wrong base
 * either re-appends rows that exist or deletes rows that do not.
 *
 * `count` is the number of the view's messages that have a row (the view is
 * always fully persisted when it is loaded, so it usually equals the view's
 * length; a message appended but not yet written is the exception).
 *
 * The caller owns the transcript array; this type never holds it, only
 * measures it when a call says what changed.
 */
export class TranscriptStore {
  /** Number of the (in-memory) view's messages with a row in the table. */
  private count: number;

  constructor(
    private readonly sessionId: string,
    private readonly repo: MessageRepo,
    /** Messages the view already had when the session opened (they were
     * loaded from the table, so their rows exist). */
    initialCount = 0,
    /** The view's first message is this position in the whole transcript.
     * 0 for a conversation that was never compacted. */
    private base = 0,
  ) {
    this.count = initialCount;
  }

  /** Length of the persisted part of the view, in VIEW positions. */
  get persistedCount(): number {
    return this.count;
  }

  /** The whole-transcript position of the view's first message. */
  get baseIndex(): number {
    return this.base;
  }

  /** The whole-transcript position the view ends at (one past its last
   * message). This is what a compaction's cut index and a rewind's target
   * are expressed in. */
  get endIndex(): number {
    return this.base + this.count;
  }

  /** Append a row for every message added since the last call. A view that
   * shrank (a rewind rewrote it) is already in step, so the count re-anchors
   * instead of re-appending rows that exist. */
  persist(messages: readonly AgentMessage[]): void {
    if (messages.length < this.count) {
      this.count = messages.length;
    }
    for (let i = this.count; i < messages.length; i++) {
      this.repo.append(this.sessionId, messages[i]!);
    }
    this.count = messages.length;
  }

  /** Write the row of one message inserted at `index` — a VIEW position, as
   * the caller splices it there afterwards (a failed write leaves memory
   * untouched and the two cannot diverge).
   *
   * The whole-transcript position is `base + index`; an insertion at or
   * before the view's start moves the base, because the view then begins one
   * message later in the transcript. */
  insertAt(index: number, message: AgentMessage): void {
    const persistedBefore = this.count;
    this.repo.insertAt(this.sessionId, this.base + index, message);
    if (index === 0) {
      // A checkpoint spliced in FRONT of the whole view (a compaction whose
      // cut is before it): the row is now the view's first, so the base
      // stays and the count grows with it.
      this.count = persistedBefore + 1;
      return;
    }
    this.count = index < persistedBefore
      ? persistedBefore + 1
      : persistedBefore;
  }

  /** The caller rewound: everything from view position `cut` on was dropped
   * from the transcript it passes, and the rows go with it. The view keeps
   * its base — a rewind truncates the END of the conversation, which is
   * always inside the view (a rewind target the view does not hold is
   * handled by the caller re-reading it). */
  forgetFrom(messages: readonly AgentMessage[], cut: number): void {
    this.count = messages.length;
    this.repo.deleteFrom(this.sessionId, this.base + cut);
  }

  /** Re-anchor after the view was replaced wholesale (a rewind that reached
   * behind it, which the caller resolved by reading the conversation again). */
  reset(base: number, initialCount: number): void {
    this.base = base;
    this.count = initialCount;
  }

  /** The whole-transcript position of the first message matching `match`, or
   * undefined. A rewind names its target by identity, and the target may be
   * older than the view the agent holds: the store is what knows where. */
  positionOf(
    match: (message: AgentMessage) => boolean,
  ): number | undefined {
    return this.repo.positionOf(this.sessionId, (row) => match(row.message));
  }

  /** Drop every row from whole-transcript position `index` on and return
   * their identities (what a client needs to drop them from its view). */
  truncateFrom(index: number): RemovedMessage[] {
    const removed = this.repo
      .list(this.sessionId)
      .slice(index)
      .map((row) => messageIdentityOf(row.message));
    this.repo.deleteFrom(this.sessionId, index);
    this.count = Math.min(this.count, Math.max(0, index - this.base));
    return removed;
  }

  /** Re-read the model's view from the store (after a rewind that reached
   * behind it) and re-anchor this store to it. */
  reload(): AgentMessage[] {
    const rows = this.repo.listModelView(this.sessionId);
    this.base = this.repo.count(this.sessionId) - rows.length;
    this.count = rows.length;
    return rows.map((row) => row.message);
  }

  /** Reduce the rows behind the newest checkpoint (see session/prune.ts) and
   * report what that freed. */
  pruneCondensed(): { changed: number; freedBytes: number } {
    return this.repo.pruneCondensed(this.sessionId);
  }
}
