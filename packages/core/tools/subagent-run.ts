/**
 * Running one sub-agent: its retries, the events it relays, and the one place
 * it settles.
 *
 * The hub (tools/task-hub.ts) decides who may spawn whom and where a result
 * goes; what happens between "the agent has a prompt" and "the run is over" —
 * a rate-limited turn, a stream cut mid-flight, a compaction splice, the row
 * that records the outcome — is one story and lives here.
 */
import type { Agent } from "../ai/agent.ts";
import type { AgentEvent } from "../ai/agent-types.ts";
import { isRetryableRateLimit } from "../ai/llm-retry.ts";
import type { NotificationPayload } from "../ai/notification.ts";
import {
  MAX_RATE_LIMIT_RETRIES,
  rateLimitRetryDelayMs,
} from "../ai/rate-limit.ts";
import {
  buildInterruptedRetryNotification,
  buildRetryNotification,
  hasNoVisibleOutput,
  isTransientStreamError,
} from "../ai/retry-policy.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { AgentMessage, AssistantMessage } from "../domain/message.ts";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import type { AgentRepo } from "../session/agents.ts";
import type { SubagentStatus } from "../shared/mod.ts";
import { formatTaskCompletion, lastAssistantText } from "./subagent-format.ts";
import type { Subagent, SubagentRegistry } from "./subagent-registry.ts";

/** Live-response tail reported while a sub-agent runs. */
const TASK_TAIL_LIMIT = 8 * 1024;

/** Module logger (debug-gated): a failed sub-agent compaction is a
 * best-effort miss, not a session failure. */
const log = createLogger("task");

/** The session a run belongs to, as a run reads it: the stores it writes
 * through, the roster it settles in, and the two ways out (an event for the
 * clients, a notification for the spawning agent). Passed in rather than
 * reached for: the hub owns them and a run only uses them. */
export interface SubagentSessionRun {
  /** The session the runs belong to: the events address it. */
  sessionId: string;
  /** The roster the runs belong to. Settling resolves its waiters and evicts
   * the oldest settled entries. */
  roster: SubagentRegistry;
  /** The session's agents: a run's row is settled here. */
  agents: AgentRepo;
  emit: (event: ClientEvent) => void;
  /** Deliver a completion notification to the agent that spawned the run. */
  notify: (parentId: string, payload: NotificationPayload) => void;
  /** Whether the session has closed: a closed run settles instead of
   * retrying, and no completion is delivered. */
  isClosed: () => boolean;
  /** Sleep before a retry backoff. */
  backoffSleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The runs of one session's sub-agents: the retry loop, the pre-step
 * compaction hook, the events a run relays, and its settlement.
 */
export class SubagentRunner {
  constructor(private readonly session: SubagentSessionRun) {}

  /** Run `agent` for `sub` in the background. The caller keeps working; the
   * outcome arrives through finalize (a notification or a waiting
   * task_output). */
  start(sub: Subagent, agent: Agent, prompt: string): void {
    void this.run(sub, agent, prompt);
  }

  /** Pre-step hook of one sub-agent: condense its history before a request
   * that would exceed its model's window is derived from it (see
   * ai/context-compaction.ts — the main agent runs the same seam). The
   * compactor is cached per sub-agent so its measurement anchor survives the
   * turns. */
  async compactBeforeStep(agentId: string, signal: AbortSignal): Promise<void> {
    const sub = this.session.roster.get(agentId);
    if (this.session.isClosed() || signal.aborted || sub === undefined) return;
    const agent = sub.agent;
    const compactor = sub.compactor;
    if (agent === null || compactor === null) return;
    try {
      await compactor.compactIfNeeded(agent.state.messages);
    } catch (error) {
      // A failed compaction must not kill the sub-agent: the request goes
      // out with the history it had.
      log.debug(`sub-agent compaction failed: ${errorMessage(error)}`);
    }
  }

  /** Relay one agent event: a finished message is a row, a text delta is the
   * live tail clients render. */
  handleEvent(sub: Subagent, event: AgentEvent): void {
    // A finished message is a row. Writing it here (rather than diffing the
    // transcript later) keeps the store in the order the loop produced it,
    // even when a compaction splice moved a checkpoint into the middle.
    if (event.type === "message_end") {
      this.persistTranscript(sub);
      return;
    }
    if (event.type !== "message_update") return;
    const inner = event.assistantMessageEvent;
    if (inner.type !== "text_delta") return;
    sub.tail = (sub.tail + inner.delta).slice(-TASK_TAIL_LIMIT);
    this.session.emit({
      type: "task_delta",
      sessionId: this.session.sessionId,
      agentId: sub.id,
      delta: inner.delta,
    });
  }

  /** Settle a sub-agent run: capture the result, resolve waiters, emit the
   * end event, and notify the spawning agent — unless it is waiting on this
   * task right now (it gets the result through task_output instead).
   * Idempotent: close() may settle the run first. */
  finalize(sub: Subagent, status: SubagentStatus, failure?: string): void {
    if (sub.status !== "running") return;
    sub.status = status;
    sub.finishedAt = Date.now();
    sub.resultText = lastAssistantText(sub.agent!.state.messages);
    // The tail of the run may hold messages no event announced (a steered
    // notification the loop appended), so the last write happens here,
    // before the agent is released.
    this.persistTranscript(sub);
    sub.unsubscribe();
    // The message history is no longer needed: its rows are in the store, so
    // the memory can go. Only the snapshot fields (kept below) stay
    // queryable.
    sub.agent = null;
    try {
      this.session.agents.settle(
        sub.id,
        status,
        sub.finishedAt,
        sub.resultText,
      );
    } catch (error) {
      // finalize also runs from close(), where there is no caller to fail:
      // log the one row that did not land instead of aborting the teardown.
      log.warn(
        `sub-agent ${sub.id}: settling its row failed: ${errorMessage(error)}`,
      );
    }
    const parentWaiting = [...sub.waiters].some(
      (waiter) => waiter.callerId === sub.parentId,
    );
    const snapshot = this.session.roster.infoOf(sub);
    for (const waiter of sub.waiters) waiter.settle(snapshot);
    sub.waiters.clear();
    this.session.emit({
      type: "task_end",
      sessionId: this.session.sessionId,
      agentId: sub.id,
      status,
    });
    if (!parentWaiting && !this.session.isClosed()) {
      this.session.notify(
        sub.parentId,
        formatTaskCompletion(snapshot, failure),
      );
    }
    this.session.roster.evictFinished();
  }

  /** Run a sub-agent to completion, retrying the two recoverable failures
   * with exponential backoff (bounded by MAX_RATE_LIMIT_RETRIES each):
   * - a rate-limited (429) turn drops the empty error turn and re-runs the
   *   same prompt (no duplicate user message),
   * - a transient transport failure (a stream cut mid-flight) continues the
   *   conversation: the partial answer stays in the transcript, and the
   *   retry asks the model to resume — repeating work would waste the
   *   tokens already spent, and dropping the turn would discard a long
   *   investigation.
   *
   * Any other outcome — success, a permanent error, an abort, or the
   * exhausted budget — settles the sub-agent once. */
  private async run(
    sub: Subagent,
    agent: Agent,
    prompt: string,
  ): Promise<void> {
    let first = true;
    /** Prompt for the next attempt; undefined → re-run the transcript. */
    let nextPrompt: AgentMessage | undefined;
    let rateLimitAttempt = 0;
    let transportAttempt = 0;

    for (;;) {
      if (sub.agent === null || this.session.isClosed()) return;
      try {
        if (first) {
          await agent.prompt(prompt);
          first = false;
        } else if (nextPrompt !== undefined) {
          await agent.prompt(nextPrompt);
        } else {
          await agent.continue();
        }
      } catch (error) {
        // The agent rejected (a race with another run): settle as failed
        // with the reason instead of a generic string.
        this.finalize(
          sub,
          "failed",
          `Sub-agent run failed to start: ${errorMessage(error)}`,
        );
        return;
      }
      if (sub.agent === null || this.session.isClosed()) return;
      const last = sub.agent.state.messages.at(-1) as
        | AssistantMessage
        | undefined;
      if (last === undefined || last.role !== "assistant") break;

      if (isRetryableRateLimit(last)) {
        if (rateLimitAttempt >= MAX_RATE_LIMIT_RETRIES) break;
        rateLimitAttempt++;
        // Drop the failed error turn so the continuation re-uses the prompt.
        // The store follows it: that turn's row was written when it ended,
        // and a ledger left ahead of the array would never write the answer
        // that replaces it.
        const messages = sub.agent.state.messages;
        if (messages.length > 0 && messages.at(-1)!.role === "assistant") {
          const kept = messages.slice(0, -1);
          sub.agent.state.messages = kept;
          const transcript = sub.transcript;
          if (transcript !== null) transcript.forgetFrom(kept, kept.length);
        }
        nextPrompt = undefined;
        if (
          !(await this.backoff(sub, rateLimitRetryDelayMs(rateLimitAttempt)))
        ) {
          this.finalize(sub, "failed", sub.agent.state.errorMessage);
          return;
        }
        continue;
      }

      if (isTransientStreamError(last)) {
        if (transportAttempt >= MAX_RATE_LIMIT_RETRIES) break;
        transportAttempt++;
        nextPrompt = hasNoVisibleOutput(last)
          ? buildRetryNotification(transportAttempt)
          : buildInterruptedRetryNotification(transportAttempt);
        if (
          !(await this.backoff(sub, rateLimitRetryDelayMs(transportAttempt)))
        ) {
          this.finalize(sub, "failed", sub.agent.state.errorMessage);
          return;
        }
        continue;
      }
      break;
    }

    const last = sub.agent?.state.messages.at(-1) as
      | AssistantMessage
      | undefined;
    this.finalize(
      sub,
      // Still running here (finalize settles it), so the agent is live.
      last?.stopReason === "error" ? "failed" : "finished",
      sub.agent?.state.errorMessage,
    );
  }

  /** Sleep before a retry. False when the wait was aborted (session closed
   * or the sub-agent killed), so the caller settles instead of retrying. */
  private async backoff(sub: Subagent, ms: number): Promise<boolean> {
    try {
      await this.session.backoffSleep(ms, sub.abort.signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Write the messages this sub-agent has appended since the last write.
   *
   * A failed write is logged, not thrown: the agent's event guard swallows
   * whatever a listener throws, and the ledger is left where it was, so the
   * next message_end writes the tail again. */
  private persistTranscript(sub: Subagent): void {
    const agent = sub.agent;
    const transcript = sub.transcript;
    if (agent === null || transcript === null) return;
    try {
      transcript.persist(agent.state.messages);
    } catch (error) {
      log.warn(
        `sub-agent ${sub.id}: persisting its transcript failed: ${errorMessage(
          error,
        )}`,
      );
    }
  }
}
