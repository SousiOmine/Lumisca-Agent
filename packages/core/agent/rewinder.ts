import { CoreError } from "../errors.ts";
import type { Agent } from "../ai/agent.ts";
import type { AgentMessage } from "../ai/types.ts";
import type { GoalRunner } from "./goal-runner.ts";
import type { RetryManager } from "./retry-manager.ts";
import type { TranscriptStore } from "./transcript.ts";

/** What a rewind needs from its session: the live transcript and the pieces
 * that hold state derived from it. Everything else (the event stream, the
 * language, the session id) is injected as small functions. */
export interface RewindDeps {
  agent: Agent;
  transcript: TranscriptStore;
  retry: RetryManager;
  /** The goal loop, when the session has one. A rewound goal declaration
   * cancels the goal. */
  goals: GoalRunner | null;
  isStreaming: () => boolean;
  abort: () => void;
  /** Re-anchor context publications after the truncation. */
  rebaseContexts: (messages: readonly AgentMessage[]) => void;
  emit: (
    event: { type: "messages_truncated"; removed: RemovedMessage[] },
  ) => void;
}

/** One message the truncation dropped, as the clients know it: the app's
 * message identity key is role + timestamp, plus the tool call id for tool
 * results (parallel results can share a millisecond). */
export interface RemovedMessage {
  role: string;
  timestamp: number;
  toolCallId?: string;
}

/**
 * Truncating a transcript from a user message onward (the undo button).
 *
 * Kept apart from the session agent because it is a self-contained state
 * transition over the agent's transcript: it stops the run, finds the cut,
 * drops the rows, cancels what the dropped messages started (a goal, a
 * parked retry) and reports what went away. Two callers wait on it — a
 * prompt delivered mid-rewind must not race the truncation.
 */
export class Rewinder {
  #inFlight: Promise<void> | null = null;

  constructor(private readonly deps: RewindDeps) {}

  /** True while a truncation is running (a prompt must wait for it). */
  get busy(): boolean {
    return this.#inFlight !== null;
  }

  /** Wait for an in-flight rewind, if any. Resolves immediately otherwise;
   * a rewind that failed (not_found) is already settled, so its own caller
   * saw the error and the wait just continues. */
  async settle(): Promise<void> {
    // The loop covers a rewind started while this awaited the previous one.
    while (this.#inFlight !== null) {
      await this.#inFlight.catch(() => {});
    }
  }

  /** Truncate from the message with `timestamp` onward. Truncation is
   * positional (the target's exact index), matching the database row order,
   * so messages sharing a millisecond with the target are handled exactly. A
   * timestamp newer than every user/mode message is treated as a queued
   * steer; any other unknown timestamp throws not_found. */
  async rewind(timestamp: number): Promise<void> {
    // Registered before the first await: a prompt delivered from here on
    // waits for the truncation (settle).
    const work = this.#run(timestamp);
    this.#inFlight = work;
    try {
      await work;
    } finally {
      if (this.#inFlight === work) this.#inFlight = null;
    }
  }

  async #run(timestamp: number): Promise<void> {
    const deps = this.deps;
    const messages = deps.agent.state.messages;
    if (deps.isStreaming()) {
      // Rejects pending asks first (via abort), so a run waiting on the
      // user's answer unwinds immediately — waitForIdle below would hang
      // until the ask tool's promise settles otherwise.
      deps.abort();
      // An aborted run normally ends as a turn; a run that died with an
      // exception instead must not block the truncation — its failure
      // belongs to whoever started it, and the rewind owns the transcript
      // from here on.
      await deps.agent.waitForIdle().catch(() => {});
    }
    const index = messages.findIndex(
      (m) =>
        (m.role === "user" || m.role === "mode") &&
        m.timestamp === timestamp,
    );
    // Goal declarations (modeId "goal") that would disappear with the
    // truncation: rewinding them away cancels the goal. Captured before the
    // splice mutates the array.
    const goalTimestamps = new Set(
      messages
        .filter(
          (m) =>
            m.role === "mode" &&
            (m as { modeId?: unknown }).modeId === "goal",
        )
        .map((m) => m.timestamp),
    );
    let removed: RemovedMessage[] = [];
    const truncateFrom = (cut: number) => {
      removed = messages.splice(cut).map((message) => ({
        role: message.role,
        timestamp: message.timestamp,
        ...(message.role === "toolResult"
          ? { toolCallId: message.toolCallId }
          : {}),
      }));
      deps.transcript.forgetFrom(messages, cut);
    };
    if (index !== -1) {
      truncateFrom(index);
    } else if (
      messages.every(
        (m) =>
          (m.role !== "user" && m.role !== "mode") ||
          m.timestamp < timestamp,
      )
    ) {
      // A queued steer: announced to clients but not in the transcript yet.
      // It is the newest message, so only messages newer than it (the
      // aborted run's artifacts) follow it in the transcript.
      const cut = messages.findIndex((m) => m.timestamp > timestamp);
      if (cut !== -1) truncateFrom(cut);
      // The steer itself has no transcript row, but clients were already
      // told about it — include it in the deletion notice so they drop it.
      removed.push({ role: "user", timestamp });
    } else {
      throw new CoreError(`User message not found: ${timestamp}`, "not_found");
    }
    deps.agent.clearAllQueues();
    // A parked silent-error restart was never announced — dropping it here
    // leaves no trace, exactly like clearing the queues.
    deps.retry.reset();
    // Rewinding away the goal's own mode message cancels the goal: the
    // declaration itself is gone, so the loop must not continue. Any other
    // rewind leaves the goal intact.
    deps.goals?.cancelWhenRewound(goalTimestamps, removed);
    // The truncation may have removed the context publications that went
    // with the rewound messages: re-anchor, so a provider whose snapshot is
    // no longer in history publishes it again before the next run.
    deps.rebaseContexts(messages);
    deps.emit({ type: "messages_truncated", removed });
  }
}
