import type { Agent } from "../ai/agent.ts";
import type { AgentMessage, AssistantMessage } from "../ai/types.ts";
import {
  buildContextOverflowRetryNotification,
  buildInterruptedRetryNotification,
  buildRateLimitRetryNotification,
  buildRetryNotification,
  hasNoVisibleOutput,
  isContextOverflowError,
  isSilentErrorResponse,
  isTransientStreamError,
  MAX_EMPTY_RESPONSE_RETRIES,
} from "./retry-policy.ts";
import {
  MAX_RATE_LIMIT_RETRIES,
  rateLimitRetryDelayMs,
  sleepAbortable,
} from "../ai/rate-limit.ts";
import { isRetryableRateLimit } from "./llm-retry.ts";
import type { NotificationMessage } from "../types/notification.ts";

/** Outcome of classifying one assistant turn for retry. */
export type RetryDecision =
  | { action: "none" }
  | { action: "followUp"; notification: NotificationMessage }
  | {
    action: "park";
    notification: NotificationMessage;
    rateLimit: boolean;
    /** True when the parked restart follows a context overflow: the history
     * must be condensed before the run restarts (see SessionAgent). */
    overflow?: boolean;
  };

/** Maximum consecutive context-overflow recoveries per exchange. One is
 * enough when the forced compaction reduces the history; a second rejection
 * means compaction could not free enough (one indivisible unit still
 * exceeds the window), so the provider's own error must surface instead of
 * looping. Mirrors DSH's `maxOverflowRetries` default. */
export const MAX_OVERFLOW_RETRIES = 1;

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
  /** Consecutive context-overflow recoveries in the current exchange.
   * Bounded: the first one condenses the history and restarts, a second
   * rejection surfaces (compaction could not free enough). */
  private overflowRetries = 0;
  /** True while a parked restart follows a context overflow: the agent
   * condenses the history before consuming it. */
  private pendingOverflow = false;
  /** The retry notification parked to restart a run after a silent-error
   * turn killed it. Consumed by resumeOnce the dead run has settled. */
  private pendingErrorRetry: NotificationMessage | null = null;
  /** The retry notification parked to restart a run after a rate-limited
   * turn. Consumed by resumeOnce (which backs off before re-prompting). */
  private pendingRateLimitRetry: NotificationMessage | null = null;
  /** Interrupts the backoff sleep of a rate-limit restart when the run is
   * aborted or the session closes. Independent of the agent's own abort
   * signal (which is cleared between runs). */
  private readonly retryAbort = new AbortController();
  /** Backoff sleep before a rate-limit restart (injectable for tests). */
  private readonly rateLimitRetrySleep: (
    ms: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Bumped on every abort(); background work spanning multiple runs
   * compares epochs so a stop pressed between two attempts stands the
   * restart down instead of firing one more request. */
  private abortEpoch = 0;

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
    this.overflowRetries = 0;
    this.pendingOverflow = false;
    this.pendingErrorRetry = null;
    this.pendingRateLimitRetry = null;
  }

  /** Abort in-flight backoff and invalidate parked restarts. */
  abort(): void {
    this.retryAbort.abort();
    this.abortEpoch++;
    this.pendingOverflow = false;
  }

  /** True when a silent-error or rate-limit restart is parked. */
  get hasPendingRestart(): boolean {
    return this.pendingErrorRetry !== null ||
      this.pendingRateLimitRetry !== null;
  }

  /** True when a parked restart follows a context overflow: the caller
   * must condense the history before it re-prompts (see resumeOnce). */
  get hasPendingOverflow(): boolean {
    return this.pendingOverflow;
  }

  /** Drop a parked restart. Used by the overflow path when the forced
   * compaction could not free anything: the retry would hit the same
   * rejection, so the provider's original error must surface instead of
   * burning another request (DSH authorizes the overflow retry only when the
   * surface replacement actually advanced). */
  clearPendingRestart(): void {
    this.pendingErrorRetry = null;
    this.pendingRateLimitRetry = null;
    this.pendingOverflow = false;
  }

  /** Classify one assistant turn: progress resets, vacant normal stops
   * retry in-run, retryable failures park a restart. Returns the decision;
   * the agent executes it (followUp on its Agent, or a parked restart via
   * resumeOnce). */
  classify(
    message: AgentMessage,
    closed: boolean,
  ): RetryDecision {
    if (message.role !== "assistant") return { action: "none" };
    const assistant = message as AssistantMessage;
    if (!hasNoVisibleOutput(assistant)) {
      // The response produced output. A transport cut after partial text is
      // still worth continuing from where it stopped — the partial answer
      // stays in the transcript, so the restart resumes instead of
      // repeating. Anything else is real progress and resets the budgets.
      if (
        !closed && isTransientStreamError(assistant) &&
        this.interruptedRetries < MAX_EMPTY_RESPONSE_RETRIES
      ) {
        this.interruptedRetries++;
        const notification = buildInterruptedRetryNotification(
          this.interruptedRetries,
        );
        this.pendingErrorRetry = notification;
        return { action: "park", notification, rateLimit: false };
      }
      this.emptyResponseRetries = 0;
      this.rateLimitRetries = 0;
      this.interruptedRetries = 0;
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
    if (
      !closed && isContextOverflowError(assistant) &&
      this.overflowRetries < MAX_OVERFLOW_RETRIES
    ) {
      this.overflowRetries++;
      this.pendingOverflow = true;
      const notification = buildContextOverflowRetryNotification(
        this.overflowRetries,
      );
      this.pendingErrorRetry = notification;
      return {
        action: "park",
        notification,
        rateLimit: false,
        overflow: true,
      };
    }
    if (!rateLimit && !transientStreamError) {
      // Outputless but not retryable: a vacant normal stop retries in-run
      // (followUp); a permanent error surfaces.
      if (assistant.stopReason === "error") return { action: "none" };
      if (closed || this.emptyResponseRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
        return { action: "none" };
      }
      this.emptyResponseRetries++;
      return {
        action: "followUp",
        notification: buildRetryNotification(this.emptyResponseRetries),
      };
    }
    // Retryable outputless failure: rate-limit or transient stream error.
    if (closed) return { action: "none" };
    if (rateLimit) {
      if (this.rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
        return { action: "none" };
      }
      this.rateLimitRetries++;
      const notification = buildRateLimitRetryNotification(
        this.rateLimitRetries,
      );
      this.pendingRateLimitRetry = notification;
      return { action: "park", notification, rateLimit: true };
    }
    // Transient stream error with no output.
    if (this.emptyResponseRetries >= MAX_EMPTY_RESPONSE_RETRIES) {
      return { action: "none" };
    }
    this.emptyResponseRetries++;
    const notification = buildRetryNotification(this.emptyResponseRetries);
    this.pendingErrorRetry = notification;
    return { action: "park", notification, rateLimit: false };
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
    const epoch = this.abortEpoch;
    while (
      !closed && this.abortEpoch === epoch &&
      (this.pendingErrorRetry !== null || this.pendingRateLimitRetry !== null)
    ) {
      const isRateLimit = this.pendingRateLimitRetry !== null;
      const message = isRateLimit
        ? this.pendingRateLimitRetry!
        : this.pendingErrorRetry!;
      if (isRateLimit) {
        this.pendingRateLimitRetry = null;
      } else {
        this.pendingErrorRetry = null;
      }
      this.pendingOverflow = false;
      if (isRateLimit) {
        const delayMs = rateLimitRetryDelayMs(this.rateLimitRetries);
        try {
          await this.rateLimitRetrySleep(delayMs, this.retryAbort.signal);
        } catch {
          // Aborted during backoff: stand down, leave the error surfaced.
          return false;
        }
      }
      try {
        await agent.prompt(message);
      } catch {
        // The restart lost a race with another run: drop the retry rather
        // than fight the live run.
        return false;
      }
    }
    return true;
  }
}
