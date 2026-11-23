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
import type { NotificationPayload } from "../ai/notification.ts";
import {
  buildInterruptedRetryNotification,
  buildRetryNotification,
  driveRetries,
  hasNoVisibleOutput,
  isRetryableRateLimit,
  isTransientStreamError,
  MAX_RATE_LIMIT_RETRIES,
  rateLimitRetryDelayMs,
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
    /** The next attempt: the message to prompt, or null to continue the
     * transcript as it stands. */
    type Attempt = { next: string | AgentMessage | null; delayMs: number };
    let pending: string | AgentMessage | null = prompt;
    let rateLimitAttempt = 0;
    let transportAttempt = 0;
    /** Why the last attempt could not start (a race with a live run). */
    let startFailure: unknown;
    let attempts = 0;

    // The retry policy is the same one the session agent uses: the driver
    // owns the loop and the backoff, this policy says what the next attempt
    // is (a fresh prompt, a continuation, or the end of the budget).
    const outcome = await driveRetries<Attempt>(
      {
        plan: () => {
          // The first attempt is the prompt the caller gave.
          if (attempts++ === 0) return { next: pending, delayMs: 0 };
          const last = this.lastAssistant(sub);
          if (last === undefined) return null;
          if (isRetryableRateLimit(last)) {
            if (rateLimitAttempt >= MAX_RATE_LIMIT_RETRIES) return null;
            rateLimitAttempt++;
            // Drop the failed error turn so the continuation re-uses the prompt.
            // The store follows it: that turn's row was written when it ended,
            // and a ledger left ahead of the array would never write the answer
            // that replaces it.
            this.dropErrorTurn(sub);
            pending = null;
            return {
              next: null,
              delayMs: rateLimitRetryDelayMs(rateLimitAttempt),
            };
          }
          if (!isTransientStreamError(last)) return null;
          if (transportAttempt >= MAX_RATE_LIMIT_RETRIES) return null;
          transportAttempt++;
          pending = hasNoVisibleOutput(last)
            ? buildRetryNotification(transportAttempt)
            : buildInterruptedRetryNotification(transportAttempt);
          return {
            next: pending,
            delayMs: rateLimitRetryDelayMs(transportAttempt),
          };
        },
        perform: async (attempt) => {
          try {
            if (attempt.next === null) await agent.continue();
            else await agent.prompt(attempt.next);
            return true;
          } catch (error) {
            // The agent rejected (a race with another run): settle as failed
            // with the reason instead of a generic string.
            startFailure = error;
            return false;
          }
        },
        delayMs: (attempt) => attempt.delayMs,
      },
      { signal: sub.abort.signal, sleep: this.session.backoffSleep },
    );
    if (!outcome) {
      this.finalize(
        sub,
        "failed",
        startFailure === undefined
          ? sub.agent?.state.errorMessage
          : `Sub-agent run failed to start: ${errorMessage(startFailure)}`,
      );
      return;
    }

    const last = this.lastAssistant(sub);
    this.finalize(
      sub,
      // Still running here (finalize settles it), so the agent is live.
      last?.stopReason === "error" ? "failed" : "finished",
      sub.agent?.state.errorMessage,
    );
  }

  /** The last message of the run, when it is an assistant turn. */
  private lastAssistant(sub: Subagent): AssistantMessage | undefined {
    if (sub.agent === null || this.session.isClosed()) return undefined;
    const last = sub.agent.state.messages.at(-1);
    if (last === undefined || last.role !== "assistant") return undefined;
    return last as AssistantMessage;
  }

  /** Drop the empty error turn a rate-limit retry replaces, so the
   * continuation re-uses the prompt. The transcript ledger follows it: a
   * ledger left ahead of the array would never write the answer that
   * replaces the row. */
  private dropErrorTurn(sub: Subagent): void {
    const live = sub.agent;
    if (live === null) return;
    const messages = live.state.messages;
    if (messages.length === 0 || messages.at(-1)!.role !== "assistant") return;
    const kept = messages.slice(0, -1);
    live.state.messages = kept;
    sub.transcript?.forgetFrom(kept, kept.length);
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
