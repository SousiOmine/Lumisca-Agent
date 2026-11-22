/**
 * Condensing one session's history.
 *
 * The rules (when a request would exceed the window, how a span is chosen and
 * summarized) live in CompactionController. This is the session's half of the
 * coordination: where its messages are, who hears about a checkpoint, what the
 * store loses behind it, and the idle timer that runs between requests.
 */

import type { AgentTool } from "../ai/agent-types.ts";
import type { Model } from "../ai/catalog.ts";
import type { CompactionStyle } from "../ai/compaction-style.ts";
import type { CompactionResult } from "../ai/context-compaction.ts";
import type { StreamFn } from "../ai/transport.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { AgentMessage, CheckpointMessage } from "../domain/message.ts";
import type { Api } from "../domain/model.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { messageIdentityOf } from "../session/transcript-window.ts";
import type { Locale } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";
import {
  CompactionController,
  type IdleCompaction,
} from "./compaction-controller.ts";
import type { TranscriptStore } from "./transcript.ts";

/** Module logger (debug-gated): a failed prune stays best effort. */
const log = createLogger("session-agent");

/** What condensing one session needs from it. Function-based where the value
 * changes under a run (a closed or streaming agent must not be condensed). */
export interface SessionCompactionHost {
  readonly sessionId: string;
  /** The model's current view, oldest first. */
  messages(): AgentMessage[];
  /** The live prompt and tool set: a mid-session model or tool change must be
   * reflected without rebuilding the compactor. */
  systemPrompt(): string;
  tools(): readonly AgentTool[];
  readonly transcript: TranscriptStore;
  /** Re-anchor the context publications a checkpoint moved past. */
  rebaseContexts(messages: AgentMessage[]): void;
  /** Publish the context updates that a compaction re-anchored. */
  publishContexts(): void;
  /** Publish a client event (see SessionEvents.emit). */
  emit(event: ClientEvent): void;
  /** Replace the live system prompt with a re-derived one. */
  setSystemPrompt(prompt: string): void;
  /** Whether rows behind a checkpoint lose their payload (see
   * SessionAgentOptions.shouldPruneCondensed and session/prune.ts). Read on
   * every prune: the answer is a setting the user can change while the
   * conversation is open. */
  shouldPruneCondensed(): boolean;
  /** What a prune freed in the store (see SessionAgentOptions.onFreedBytes). */
  freedBytes(bytes: number): void;
  isClosed(): boolean;
  isStreaming(): boolean;
}

export interface SessionCompactionOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  style: CompactionStyle;
  language: Locale;
  policy: (() => CompactionPolicyInput) | undefined;
  idle: IdleCompaction | null;
  /** Re-derive the session's system prompt; undefined when the prompt stays
   * as it was built (see SessionAgentOptions.refreshSystemPrompt). */
  refreshSystemPrompt: (() => string) | undefined;
}

export class SessionCompaction {
  private readonly compactor: CompactionController;
  private readonly refreshSystemPrompt: (() => string) | undefined;

  constructor(
    private readonly host: SessionCompactionHost,
    options: SessionCompactionOptions,
  ) {
    // The compactor reads the live prompt and tools, so a mid-session model or
    // tool change is reflected without rebuilding it; the checkpoint is
    // inserted at the cut and the model's view starts there (nothing is
    // deleted).
    this.compactor = new CompactionController(
      {
        sessionId: host.sessionId,
        messages: () => host.messages(),
        isStreaming: () => host.isStreaming(),
        isClosed: () => host.isClosed(),
        insertHistory: (index, message) => this.insertHistory(index, message),
        publishContexts: () => host.publishContexts(),
        refreshPrompt: () => this.refreshPrompt(),
        onCompacted: (index, message) =>
          this.announceCheckpoint(index, message),
      },
      {
        model: options.model,
        systemPrompt: () => host.systemPrompt(),
        tools: () => host.tools(),
        streamFn: options.streamFn,
        style: options.style,
        language: options.language,
        policy: options.policy,
        idle: options.idle,
      },
    );
    this.refreshSystemPrompt = options.refreshSystemPrompt;
  }

  /** The idle rule of this conversation (see CompactionController); null →
   * the idle path is off. */
  get idle(): IdleCompaction | null {
    return this.compactor.idle;
  }

  /** Pre-step hook of the agent loop (see CompactionController). */
  beforeStep(signal: AbortSignal): Promise<void> {
    return this.compactor.beforeStep(signal);
  }

  /** Arm the idle rule for the silence that follows this point. */
  armIdle(): void {
    this.compactor.armIdle();
  }

  disarmIdle(): void {
    this.compactor.disarmIdle();
  }

  /** Condense unconditionally, after the provider said the request did not
   * fit (see CompactionController). */
  compactForOverflow(): Promise<CompactionResult | null> {
    return this.compactor.compactForOverflow();
  }

  /** Condense the history on demand (the manual `/compact` path). Resolves
   * with what was summarized, or undefined when no safe span existed or the
   * summarization failed — the transcript is then unchanged either way. */
  compactNow(instructions?: string): Promise<CompactionResult | undefined> {
    return this.compactor.compactNow(instructions);
  }

  /** Drop the payload of every row behind the newest checkpoint (see
   * session/prune.ts), when this session keeps only what its conversation
   * shows. Best effort: a failed write leaves the rows as they were, and the
   * next compaction or open tries again.
   *
   * The bytes it freed are reported, so the pool can note that the database
   * FILE is now mostly free pages: SQLite reuses them but never shrinks, and
   * the rewrite happens at the next start, before any request (see
   * db/vacuum.ts). */
  pruneCondensedRows(): void {
    if (this.host.isClosed() || !this.host.shouldPruneCondensed()) return;
    try {
      const result = this.host.transcript.pruneCondensed();
      if (result.freedBytes > 0) this.host.freedBytes(result.freedBytes);
    } catch (error) {
      log.warn(
        `session ${this.host.sessionId}: pruning condensed rows failed: ${errorMessage(
          error,
        )}`,
      );
    }
  }

  /** Re-derive the system prompt: a compaction replaced the history behind
   * it, which is the one point where the request's cached prefix has to
   * change anyway. */
  private refreshPrompt(): void {
    if (this.refreshSystemPrompt === undefined) return;
    this.host.setSystemPrompt(this.refreshSystemPrompt());
  }

  /** A checkpoint landed: tell clients (anchored by identity) and drop the
   * summarized payloads. The idle path appends its checkpoint after the last
   * message, so there is nothing to anchor the row to — and no client of that
   * path draws checkpoints (stella's stream drops them; the next snapshot
   * carries the row). */
  private announceCheckpoint(index: number, message: CheckpointMessage): void {
    const before = this.host.messages()[index + 1];
    if (before !== undefined) {
      this.host.emit({
        type: "messages_checkpoint",
        sessionId: this.host.sessionId,
        before: messageIdentityOf(before),
        message,
      });
    }
    // The span the checkpoint just summarized is no longer read by anyone
    // (the model starts at the checkpoint, and a client never receives tool
    // traffic at all), so its payload is dropped now — while the conversation
    // is being condensed anyway.
    this.pruneCondensedRows();
  }

  /** Insert `message` at `index`: the row first (a failed write leaves
   * memory untouched, so the two can never diverge), then the in-memory
   * transcript and the clients. Used by the context compactor through its
   * `insert` callback; the persisted-row bookkeeping lives in the
   * {@link TranscriptStore}. */
  private insertHistory(index: number, message: AgentMessage): void {
    const host = this.host;
    host.transcript.insertAt(index, message);
    host.messages().splice(index, 0, message);
    // The insertion may have moved the model's view past the context
    // publications the older messages carried: re-anchor so a provider
    // whose snapshot is no longer visible publishes it again before the
    // next request (the caller publishes what the re-anchoring queued).
    host.rebaseContexts(host.messages());
  }
}
