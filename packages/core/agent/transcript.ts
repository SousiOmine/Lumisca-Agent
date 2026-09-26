import type { AgentMessage } from "../ai/types.ts";
import type { MessageRepo } from "../session/messages.ts";

/**
 * The persisted prefix of a session's transcript: the rows this session owns
 * in the messages table, and how many leading messages of the in-memory
 * transcript those rows cover.
 *
 * That counter is the reason this type exists. The transcript lives in
 * memory (the Agent's state) and is written to SQLite as it grows, and the
 * two are only ever *meant* to be advanced together: append the tail as
 * messages are added, insert one row when compaction splices a checkpoint
 * into the middle, drop a suffix when a rewind truncates. Owning the counter
 * next to the repo calls keeps "database first, then memory" and the recount
 * after a mid-transcript insert in one place, so no caller has to re-derive
 * them (a wrong count either re-appends rows that exist or skips rows that
 * do not).
 *
 * The caller owns the transcript array; this type never holds it, only
 * measures it when a call says what changed.
 */
export class TranscriptStore {
  /** Number of leading transcript messages with a row in the table. */
  private count: number;

  constructor(
    private readonly sessionId: string,
    private readonly repo: MessageRepo,
    /** Messages the transcript already had when the session opened (they
     * were loaded from the table, so their rows exist). */
    initialCount = 0,
  ) {
    this.count = initialCount;
  }

  /** Length of the persisted prefix: the messages up to here have rows. */
  get persistedCount(): number {
    return this.count;
  }

  /** Append a row for every message added since the last call. A transcript
   * that shrank (a compaction replaced a span) is already in step, so the
   * count re-anchors instead of re-appending rows that exist. */
  persist(messages: readonly AgentMessage[]): void {
    if (messages.length < this.count) {
      this.count = messages.length;
    }
    for (let i = this.count; i < messages.length; i++) {
      this.repo.append(this.sessionId, messages[i]!);
    }
    this.count = messages.length;
  }

  /** Write the row of one message inserted at `index` (the caller splices
   * its transcript afterwards, so a failed write leaves memory untouched and
   * the two cannot diverge).
   *
   * The count is recomputed, not reset: the messages before `index` had rows
   * already, so the rows that followed the insertion point are still
   * persisted after it — only the messages up to and including the inserted
   * one are counted, and whatever trailed the persisted prefix is written by
   * the next `persist`. */
  insertAt(index: number, message: AgentMessage): void {
    const persistedBefore = this.count;
    this.repo.insertAt(this.sessionId, index, message);
    this.count = index < persistedBefore
      ? persistedBefore + 1
      : persistedBefore;
  }

  /** The caller rewound: everything from `cut` on was dropped from the
   * transcript it passes, and the rows go with it. */
  forgetFrom(messages: readonly AgentMessage[], cut: number): void {
    this.count = messages.length;
    this.repo.deleteFrom(this.sessionId, cut);
  }
}
