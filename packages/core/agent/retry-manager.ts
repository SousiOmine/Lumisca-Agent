import type { Agent } from "../ai/agent.ts";
import {
  buildContextOverflowRetryNotification,
  buildInterruptedRetryNotification,
  buildOutputCapRetryNotification,
  buildRateLimitRetryNotification,
  buildRetryNotification,
  driveRetries,
  hasNoVisibleOutput,
  isContextOverflowError,
  isOutputCapStop,
  isRetryableRateLimit,
  isSilentErrorResponse,
  isTransientStreamError,
  MAX_EMPTY_RESPONSE_RETRIES,
  MAX_OUTPUT_CAP_RETRIES,
  MAX_OVERFLOW_RETRIES,
  MAX_RATE_LIMIT_RETRIES,
  type RetryAttempt,
  rateLimitRetryDelayMs,
  sleepAbortable,
} from "../ai/retry-policy.ts";
import type {
  AgentMessage,
  AssistantMessage,
  NotificationMessage,
} from "../domain/message.ts";

/** Outcome of classifying one assistant turn for retry.
 *
 * Both ways to retry share one shape: an `in-run` attempt is handed to the
 * live loop (Agent.followUp), a `restart` attempt is parked and consumed
 * once the dead run settled (resumeOnce). The budgets, the notification and
 * the backoff live on the attempt, so the caller only picks the delivery. */
export type RetryDecision =
  | { action: "none" }
  /** The response was vacant and this was the LAST retry the budget
   * allowed: the run ends empty, and the user has to be told why (the
   * session agent reports it; `count` is how many retries were spent). */
  | { action: "exhausted"; count: number; message?: string }
  | {
      action: "retry";
      attempt: RetryAttempt;
      delivery: "in-run" | "restart";
    };

/** Owns the vacant-response / rate-limit retry state of one session agent.
 * Extracted from SessionAgent so the retry budgets, the parked restart
 * notifications, and the abort epochs live in one testable unit; the agent
 * keeps only the turn wiring (classify → act → resume). */
export class RetryManager {
  /** Consecutive vacant responses (no text, no tool call) in the current
   * exchange. Each one is retried up to MAX_EMPTY_RESPONSE_RETRIES — a
   * mid-run vacancy via followUp, a silent error by restarting the run;
   * a response with output resets the count. Runs started from outside
   * reset it at their entry points. */
  private emptyResponseRetries = 0;
  /** Consecutive rate-limited (429) turns in the current exchange, retried
   * with exponential backoff. A separate budget from the vacant-response
   * retries so a rate-limit storm cannot be cut short by the vacant cap,
   * nor starve it. */
  private rateLimitRetries = 0;
  /** Consecutive responses the transport cut off AFTER they produced
   * output, restarted with a "continue from where it stopped"
   * instruction. Bounded like the other budgets so a provider that keeps
   * dropping long streams cannot loop forever (each restart re-sends the
   * whole conversation, so an unbounded chain would burn quota). */
  private interruptedRetries = 0;
  /** Consecutive responses the provider cut at the output cap (finish
   * reason "length"). A separate budget from the transport interruption:
   * a model whose answer does not fit in the cap will keep hitting it, and
   * the point of retrying is to let it finish in a second turn, not to
   * treat the cut as a broken connection. */
  private outputCapRetries = 0;
  /** Consecutive context-overflow recoveries in the current exchange.
   * Bounded: the first one condenses the history and restarts, a second
   * rejection surfaces (compaction could not free enough). */
  private overflowRetries = 0;
  /** The attempts parked to restart a run that a retryable failure killed,
   * oldest first. Consumed by resumeOnce once the dead run has settled, so
   * an abort that lands between two restarts leaves the later ones parked
   * (and stood down by the epoch check). */
  private pending: RetryAttempt[] = [];
  /** Interrupts the backoff sleep of a rate-limit restart when the run is
   * aborted or the session closes. Independent of the agent's own abort
   * signal (which is cleared between runs), and REPLACED by every abort():
   * an AbortSignal is one-way, so reusing the aborted controller would make
   * every later backoff sleep fail immediately and silently drop the
   * retry for the rest of the session. Standing down the restarts that
   * were parked at the moment of the abort is `abortEpoch`'s job. */
  private retryAbort = new AbortController();
  /** Backoff sleep before a rate-limit restart (injectable for tests). */
  private readonly rateLimitRetrySleep: (
    ms: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Bumped on every abort(); background work spanning multiple runs
   * compares epochs so a stop pressed between two attempts stands the
   * restart down instead of firing one more request. */
  private abortEpoch = 0;
  /** The epoch the currently parked attempts were handed out under. */
  private parkedEpoch = 0;

  constructor(
    rateLimitRetrySleep: (
      ms: number,
      signal?: AbortSignal,
    ) => Promise<void> = sleepAbortable,
  ) {
    this.rateLimitRetrySleep = rateLimitRetrySleep;
  }

  /** Reset the retry state for a fresh exchange. A user prompt, a
   * notification that starts its own run, or a goal-loop turn all start a
   * fresh exchange: they do not inherit the previous run's
   * vacant-response / rate-limit retry history. */
  reset(): void {
    this.emptyResponseRetries = 0;
    this.rateLimitRetries = 0;
    this.interruptedRetries = 0;
    this.outputCapRetries = 0;
    this.overflowRetries = 0;
    this.pending = [];
  }

  /** Abort in-flight backoff and invalidate parked restarts. */
  abort(): void {
    this.retryAbort.abort();
    // The signal is spent: a later backoff must be interruptible again.
    this.retryAbort = new AbortController();
    this.abortEpoch++;
  }

  /** True when a restart is parked. */
  get hasPendingRestart(): boolean {
    return this.pending.length > 0;
  }

  /** True when the parked restart follows a context overflow: the caller
   * must condense the history before it re-prompts (see resumeOnce). */
  get hasPendingOverflow(): boolean {
    return this.pending.length > 0 && this.pending[0]!.reason === "overflow";
  }

  /** Drop a parked restart. Used by the overflow path when the forced
   * compaction could not free anything: the retry would hit the same
   * rejection, so the provider's original error must surface instead of
   * burning another request (DSH authorizes the overflow retry only when the
   * surface replacement actually advanced). */
  clearPendingRestart(): void {
    this.pending = [];
  }

  /** Classify one assistant turn: progress resets, vacant normal stops
   * retry in-run, retryable failures park a restart. Returns the decision;
   * the agent executes it (followUp on its Agent, or a parked restart via
   * resumeOnce). */
  classify(message: AgentMessage, closed: boolean): RetryDecision {
    if (message.role !== "assistant") return { action: "none" };
    const assistant = message as AssistantMessage;
    // An answer the provider cut at the output cap is incomplete even though
    // it has visible text: continue it instead of treating it as finished.
    // Checked first because the visible text would otherwise reset the
    // budgets below and the model would never be asked to go on.
    if (isOutputCapStop(assistant)) {
      const attempt = this.continuation(
        !closed,
        this.outputCapRetries,
        MAX_OUTPUT_CAP_RETRIES,
        "output-cap",
        buildOutputCapRetryNotification,
      );
      if (attempt !== null) return this.park(attempt);
    }
    if (!hasNoVisibleOutput(assistant)) {
      // The response produced output. A transport cut after partial text is
      // still worth continuing from where it stopped — the partial answer
      // stays in the transcript, so the restart resumes instead of
      // repeating. Anything else is real progress and resets the budgets.
      const attempt = this.continuation(
        !closed && isTransientStreamError(assistant),
        this.interruptedRetries,
        MAX_EMPTY_RESPONSE_RETRIES,
        "interrupted",
        buildInterruptedRetryNotification,
      );
      if (attempt !== null) return this.park(attempt);
      this.emptyResponseRetries = 0;
      this.rateLimitRetries = 0;
      this.interruptedRetries = 0;
      this.outputCapRetries = 0;
      return { action: "none" };
    }
    if (assistant.stopReason === "aborted") return { action: "none" };
    const rateLimit = isRetryableRateLimit(assistant);
    const transientStreamError = isSilentErrorResponse(assistant);
    // Context overflow is recoverable, but only by shrinking the history:
    // park a restart that the agent condenses before consuming. Checked
    // before the vacant/transient branches because an overflow arrives as an
    // error-stopped turn like they do — its wording is what distinguishes
    // it. A second rejection within the same exchange means compaction could
    // not free enough, so the provider's own error surfaces.
    if (isContextOverflowError(assistant)) {
      const attempt = this.continuation(
        !closed,
        this.overflowRetries,
        MAX_OVERFLOW_RETRIES,
        "overflow",
        buildContextOverflowRetryNotification,
      );
      if (attempt !== null) return this.park(attempt);
    }
    if (!rateLimit && !transientStreamError) {
      // Outputless but not retryable: a vacant normal stop retries in-run
      // (followUp); a permanent error surfaces.
      if (assistant.stopReason === "error" || closed) {
        return { action: "none" };
      }
      if (this.emptyResponseRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
        // The budget is spent: the turn ends with nothing to show and
        // nothing left to try. Say so — a run that stops without text, a
        // tool call or an error reads as the agent ignoring the prompt.
        return { action: "exhausted", count: this.emptyResponseRetries };
      }
      this.emptyResponseRetries++;
      return {
        action: "retry",
        delivery: "in-run",
        attempt: {
          notification: buildRetryNotification(this.emptyResponseRetries),
          delayMs: 0,
          reason: "vacant",
        },
      };
    }
    // Retryable outputless failure: rate-limit or transient stream error.
    if (closed) return { action: "none" };
    if (rateLimit) {
      if (this.rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
        return {
          action: "exhausted",
          count: this.rateLimitRetries,
          ...(assistant.errorMessage !== undefined
            ? { message: assistant.errorMessage }
            : {}),
        };
      }
      this.rateLimitRetries++;
      return this.park({
        notification: buildRateLimitRetryNotification(this.rateLimitRetries),
        delayMs: rateLimitRetryDelayMs(this.rateLimitRetries),
        reason: "rate-limit",
      });
    }
    // Transient stream error with no output.
    if (this.emptyResponseRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
      return {
        action: "exhausted",
        count: this.emptyResponseRetries,
        ...(assistant.errorMessage !== undefined
          ? { message: assistant.errorMessage }
          : {}),
      };
    }
    this.emptyResponseRetries++;
    return this.park({
      notification: buildRetryNotification(this.emptyResponseRetries),
      delayMs: 0,
      reason: "vacant",
    });
  }

  /** One continuation attempt, or null when the session is closed or the
   * budget is spent. The counter and the notification are built here so
   * every "continue the answer" case is one shape. */
  private continuation(
    applies: boolean,
    spent: number,
    budget: number,
    reason: RetryAttempt["reason"],
    build: (attempt: number) => NotificationMessage,
  ): RetryAttempt | null {
    if (!applies || spent >= budget) return null;
    this.countRetry(reason);
    return { notification: build(spent + 1), delayMs: 0, reason };
  }

  /** Count one spent retry against its budget. */
  private countRetry(reason: RetryAttempt["reason"]): void {
    switch (reason) {
      case "vacant":
        this.emptyResponseRetries++;
        return;
      case "interrupted":
        this.interruptedRetries++;
        return;
      case "output-cap":
        this.outputCapRetries++;
        return;
      case "overflow":
        this.overflowRetries++;
        return;
      case "rate-limit":
        this.rateLimitRetries++;
        return;
    }
  }

  /** Park a restart: the run is dead, so the attempt is consumed by
   * resumeOnce once it settled. */
  private park(attempt: RetryAttempt): RetryDecision {
    this.pending.push(attempt);
    return { action: "retry", delivery: "restart", attempt };
  }

  /** The next attempt the parked restart asks for, or null when nothing is
   * parked (or the exchange was aborted since it was parked). Pure: it reads
   * the parked state and the budget, and leaves both to `takeAttempt`. */
  nextAttempt(): RetryAttempt | null {
    if (this.abortEpoch !== this.parkedEpoch) return null;
    return this.pending[0] ?? null;
  }

  /** Consume the parked attempt `nextAttempt` returned: the restart it
   * describes will run, so it must not fire twice. */
  takeAttempt(): void {
    this.pending.shift();
  }

  /** Restart a run that a silent-error turn killed: the parked retry
   * notification becomes the next prompt once the dead run has settled.
   * Rate-limit restarts back off before re-prompting; silent-error
   * restarts retry immediately. Returns false when the restart stood down
   * (abort raced it, or another run took over). */
  async resumeOnce(
    agent: Pick<Agent, "prompt">,
    closed: boolean,
  ): Promise<boolean> {
    if (closed) return true;
    // The attempts parked when the loop started are the ones this call
    // consumes: an abort() during a backoff stands the rest down (see
    // nextAttempt's epoch check).
    this.parkedEpoch = this.abortEpoch;
    return await driveRetries<RetryAttempt>(
      {
        plan: () => this.nextAttempt(),
        perform: async (attempt) => {
          this.takeAttempt();
          try {
            await agent.prompt(attempt.notification);
            return true;
          } catch {
            // The restart lost a race with another run: drop the retry
            // rather than fight the live run.
            return false;
          }
        },
        delayMs: (attempt) => attempt.delayMs,
      },
      {
        // Only a sleep that is running right now is interrupted here; a
        // restart parked before the abort is stood down by the epoch check.
        sleep: (ms) => this.rateLimitRetrySleep(ms, this.retryAbort.signal),
      },
    );
  }
}
