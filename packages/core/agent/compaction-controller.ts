import type { CompactionStyle } from "../ai/compaction-style.ts";
import {
  type CompactionResult,
  ContextCompactor,
} from "../ai/context-compaction.ts";
import type {
  AgentMessage,
  AgentTool,
  Api,
  CheckpointMessage,
  Model,
  StreamFn,
} from "../ai/types.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import type { Locale } from "../shared/mod.ts";
import type { CompactionPolicyInput } from "../shared/settings-keys.ts";

const log = createLogger("compaction");

/** When an idle conversation is condensed (see
 * SessionAgentOptions.idleCompaction and CompactionController.afterIdle).
 *
 * The whole model view is condensed: nothing stays verbatim. The retention
 * budgets of the other paths protect a request that is being answered, and an
 * idle conversation has none — its last unit is a finished reply. Keeping
 * that tail would send a completed turn's tool traffic, and on a model that
 * requires its reasoning blocks replayed, its thinking, as the context of the
 * next message: the same cost the idle check exists to avoid. */
export interface IdleCompaction {
  /** Silence since the newest message that arms the check. */
  afterMs: number;
  /** Only condense when the projected context is at least this large: a
   * short conversation has nothing worth a summarization call. */
  minTokens: number;
}

/**
 * What the controller needs from the session it belongs to. Function-based
 * rather than a reference to the agent: the controller reads the live
 * transcript and asks the host to write a checkpoint, but it does not own
 * either.
 */
export interface CompactionHost {
  readonly sessionId: string;
  /** The model's current view, oldest first. */
  messages(): AgentMessage[];
  isStreaming(): boolean;
  isClosed(): boolean;
  /** Persist the checkpoint and insert it in memory (see ContextCompactor). */
  insertHistory(index: number, message: AgentMessage): void;
  /** Publish the context updates that a compaction re-anchored. */
  publishContexts(): void;
  /** A checkpoint landed: tell clients and drop the summarized payloads. */
  onCompacted(index: number, message: CheckpointMessage): void;
}

export interface CompactionOptions {
  model: Model<Api>;
  systemPrompt: () => string;
  tools: () => readonly AgentTool[];
  streamFn: StreamFn;
  style: CompactionStyle;
  language: Locale;
  policy: (() => CompactionPolicyInput) | undefined;
  idle: IdleCompaction | null;
}

/**
 * When and how the history is condensed: the pressure check before every
 * request, the forced retry after a context-overflow error, the manual
 * `/compact`, and the idle timer.
 *
 * One owner for all four paths is what keeps them agreeing on the policy and
 * on the rule that a compaction that summarized a context publication
 * republishes it (the provider's anchor is gone, and a value the model never
 * sees again is lost).
 */
export class CompactionController {
  private readonly compactor: ContextCompactor;
  private readonly idleRule: IdleCompaction | null;
  /** The pending idle compaction (see armIdle); null when none is armed. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: CompactionHost,
    options: CompactionOptions,
  ) {
    this.compactor = new ContextCompactor({
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      streamFn: options.streamFn,
      sessionId: host.sessionId,
      style: options.style,
      language: options.language,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      insert: (index, message) => host.insertHistory(index, message),
      onCompacted: (result, message) => host.onCompacted(result.index, message),
    });
    this.idleRule = options.idle;
    this.armIdle();
  }

  /** Condense unconditionally, after the provider said the request did not
   * fit. Returns null when nothing could be condensed. */
  async compactForOverflow(): Promise<CompactionResult | null> {
    try {
      const result = await this.compactor.compactIfNeeded(
        this.host.messages(),
        { force: true },
      );
      if (result !== null) this.republishContextsAfter(result);
      return result;
    } catch (error) {
      log.warn(
        `session ${this.host.sessionId}: overflow compaction failed: ${errorMessage(
          error,
        )}`,
      );
      return null;
    }
  }

  /** Pre-step hook of the agent loop: condense the history before a request
   * that would exceed the model's window is derived from it. Running here
   * (rather than only when a run ends) is what keeps a tool-heavy turn from
   * growing past the window mid-turn. A failed replacement must not kill the
   * run: the request then goes out with the history it had. */
  async beforeStep(signal: AbortSignal): Promise<void> {
    if (this.host.isClosed() || signal.aborted) return;
    try {
      const result = await this.compactor.compactIfNeeded(this.host.messages());
      if (result !== null) this.republishContextsAfter(result);
    } catch (error) {
      log.warn(
        `session ${this.host.sessionId}: compaction failed: ${errorMessage(
          error,
        )}`,
      );
    }
  }

  /** The idle rule this controller was built with (tests read it to check
   * which sessions get the idle path). */
  get idle(): IdleCompaction | null {
    return this.idleRule;
  }

  /** Condense the history on demand (the manual `/compact` path). Resolves
   * with what was summarized, or undefined when no safe span existed or the
   * summarization failed. */
  async compactNow(
    instructions?: string,
  ): Promise<CompactionResult | undefined> {
    if (this.host.isClosed()) return undefined;
    const result = await this.compactor.compactNow(this.host.messages(), {
      instructions,
    });
    if (result !== null) this.republishContextsAfter(result);
    return result ?? undefined;
  }

  /** Arm the idle compaction (built once, then after every run).
   *
   * The gap is measured from the transcript's newest message, not from the
   * moment this is called: a conversation reopened in a new process (or after
   * a restart) may already have been silent for longer than the period. The
   * timer is armed per silence and is never re-armed by its own check, so a
   * history that needs no condensing is not asked about again until the
   * conversation is used.
   *
   * The timer does not hold the process open: a server that shuts down (or a
   * test that finishes) must not wait for it. */
  armIdle(): void {
    this.disarmIdle();
    const rule = this.idleRule;
    if (this.host.isClosed() || rule === null) return;
    const newest = this.host.messages().at(-1)?.timestamp;
    if (newest === undefined) return;
    const timer = setTimeout(
      () => {
        this.idleTimer = null;
        void this.compactAfterIdle(rule);
      },
      Math.max(0, newest + rule.afterMs - Date.now()),
    );
    // Deno's signature says `number`; Bun hands back a timer object, and the
    // shim's `unrefTimer` unrefs it. The cast states that difference once,
    // here, instead of typing every timer in the agent as Deno's.
    Deno.unrefTimer(timer as unknown as number);
    this.idleTimer = timer;
  }

  disarmIdle(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** The idle timer fired: condense the whole view even below the pressure
   * threshold, once the projection is large enough to be worth it. A run that
   * started meanwhile owns the transcript: it cancelled this timer at its
   * start, and this path re-checks. */
  private async compactAfterIdle(rule: IdleCompaction): Promise<void> {
    if (this.host.isClosed() || this.host.isStreaming()) return;
    const messages = this.host.messages();
    if (this.compactor.measure(messages) < rule.minTokens) return;
    // The summarization call takes a while, and the conversation can be
    // picked up in the middle of it: the checkpoint may only land on the
    // transcript this check selected.
    const length = messages.length;
    const newest = messages.at(-1)?.timestamp;
    try {
      const result = await this.compactor.compactNow(messages, {
        // Zero: keep no tail (see IdleCompaction).
        keepRecentTokens: 0,
        canCommit: () =>
          !this.host.isClosed() &&
          !this.host.isStreaming() &&
          this.host.messages().length === length &&
          this.host.messages().at(-1)?.timestamp === newest,
      });
      if (result !== null) this.republishContextsAfter(result);
    } catch (error) {
      log.warn(
        `session ${this.host.sessionId}: idle compaction failed: ${errorMessage(
          error,
        )}`,
      );
    }
  }

  /** After a compaction: publish the context updates that the re-anchoring
   * queued. Only a compaction that summarized a context publication can
   * queue one. */
  private republishContextsAfter(result: CompactionResult): void {
    const lostProvider = result.summarized.some(
      (message) => message.role === "context",
    );
    if (!lostProvider) return;
    this.host.publishContexts();
  }
}
