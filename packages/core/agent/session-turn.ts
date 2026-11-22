/**
 * What a session does at a turn boundary: take back a reply that is not one,
 * and classify the turn for the retry policy.
 *
 * Both are about a completed assistant message, and both are the point where
 * the run policy touches the transcript: a reply whose app card does not parse
 * must not get a row, and a turn that produced nothing may have to be retried
 * (in-run, or by restarting the run once the dead one settled). The
 * classification itself lives in RetryManager; this is where its decisions are
 * carried out.
 */

import type { Agent } from "../ai/agent.ts";
import type { CompactionResult } from "../ai/context-compaction.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { AgentMessage, AssistantMessage } from "../domain/message.ts";
import { createLogger } from "../log.ts";
import type { Locale } from "../shared/mod.ts";
import { contentText, translate } from "../shared/mod.ts";
import { firstAppCardProblem } from "../shared/ui-app/check.ts";
import {
  appCardRetryNotification,
  MAX_APP_CARD_RETRIES,
} from "./app-card-repair.ts";
import type { RetryManager } from "./retry-manager.ts";
import type { TranscriptStore } from "./transcript.ts";

/** Module logger (debug-gated): a died run and a retried one land here, so a
 * failure that never reaches the transcript is still visible in the log. */
const log = createLogger("session-agent");

/** What the turn policy needs from the session that owns it. */
export interface SessionTurnHost {
  readonly sessionId: string;
  readonly agent: Agent;
  readonly transcript: TranscriptStore;
  readonly retry: RetryManager;
  /** An overflow restart condenses the history before its first request. */
  readonly compaction: {
    compactForOverflow(): Promise<CompactionResult | null>;
  };
  /** The language of the text this session writes into the transcript. */
  readonly language: Locale;
  isClosed(): boolean;
  /** Publish a client event (see SessionEvents.emit). */
  emit(event: ClientEvent): void;
  /** Drop the card of a reply that is being taken back (see
   * SessionEvents.endTextUi). */
  endTextUi(): void;
}

/**
 * The turn-boundary decisions of one session: the app-card take-back, the
 * retry classification, the restart chain after a dead run, and the failure
 * report to the user.
 */
export class SessionTurn {
  /** Consecutive app card failures in the current exchange (see
   * discardBrokenAppCard). */
  private appCardRetries = 0;

  constructor(private readonly host: SessionTurnHost) {}

  /** Reset the retry state for a fresh exchange. A user prompt, a
   * notification that starts its own run start a fresh exchange: they do
   * not inherit the previous run's
   * vacant-response / rate-limit retry history. */
  resetRetryState(): void {
    this.host.retry.reset();
    this.appCardRetries = 0;
  }

  /** A completed reply whose app card does not parse is not a reply: take
   * it out of the transcript before it is persisted, tell the client to drop
   * what it streamed, and ask the model to write it again. Returns true when
   * the message was consumed.
   *
   * Only a text-only final turn can be taken back this way; a turn ending in
   * a tool call is narration, and its tool results would follow it in the
   * transcript. */
  discardBrokenAppCard(message: AssistantMessage): boolean {
    const host = this.host;
    if (message.stopReason !== "stop") return false;
    const failure = firstAppCardProblem(contentText(message.content));
    if (failure === null) {
      this.appCardRetries = 0;
      return false;
    }
    const messages = host.agent.state.messages;
    if (messages.at(-1) !== message) return false;
    messages.pop();
    // The prompt and the turns before the failed reply still belong to the
    // conversation; the reply itself must not get a row.
    host.transcript.persist(messages);
    host.endTextUi();
    host.emit({ type: "message_discarded", sessionId: host.sessionId });
    if (this.appCardRetries >= MAX_APP_CARD_RETRIES) {
      host.emit({
        type: "session_error",
        sessionId: host.sessionId,
        message: translate(host.language, "session.appCardFailed", {
          problem: failure.problem,
        }),
      });
      return true;
    }
    this.appCardRetries++;
    const notification = appCardRetryNotification(
      this.appCardRetries,
      failure,
      contentText(message.content),
    );
    host.agent.followUp({
      ...notification,
      timestamp: host.agent.nextTimestamp(),
    });
    return true;
  }

  /** Surface a model-stream failure to the user. An assistant message that
   * ended with stopReason "error" carries the provider's error text, but
   * the web UI does not render it from the message itself: the empty
   * content leaves a silent run. The retry mechanism is
   * unaffected: a transient failure still parks its retry (turnEnded),
   * and the error banner clears when the restarted run starts
   * (agent_start). */
  reportModelError(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    if (assistant.stopReason !== "error") return;
    const text = assistant.errorMessage?.trim();
    this.host.emit({
      type: "session_error",
      sessionId: this.host.sessionId,
      message: text ? text : "The model returned an error",
    });
  }

  /** Retry an outputless assistant response. Classification lives in
   * RetryManager; the turn policy only executes the decision (an in-run
   * vacant retry via followUp, a parked restart consumed by
   * resumeAfterErrorRun). Permanent failures surface immediately — they can
   * never recover. A transient failure that cut a response off *after* it
   * produced output also parks a restart, which asks the model to continue
   * from where it stopped instead of repeating the answer.
   *
   * An "exhausted" decision ends the run empty: the retries are spent and
   * the turn produced nothing, so the user is told (a run that stops
   * without text, a tool call or an error reads as the agent ignoring the
   * prompt). */
  turnEnded(message: AgentMessage): void {
    const host = this.host;
    const decision = host.retry.classify(message, host.isClosed());
    if (decision.action === "followUp") {
      host.agent.followUp(decision.notification);
    }
    if (decision.action === "exhausted") {
      host.emit({
        type: "session_error",
        sessionId: host.sessionId,
        message:
          decision.message === undefined
            ? translate(host.language, "session.vacantResponse", {
                count: decision.count,
              })
            : translate(host.language, "session.retryExhausted", {
                count: decision.count,
                message: decision.message,
              }),
      });
    }
    // "park" decisions are consumed by resumeAfterErrorRun once the dead
    // run settles; "none" needs nothing.
    if (
      message.role === "assistant" &&
      (message as AssistantMessage).stopReason === "error"
    ) {
      // A run that dies leaves a trace: the desktop shell captures the
      // server's output for copy-paste, and these failures used to be
      // invisible outside the transcript. A recoverable failure (a restart
      // is parked) stays at debug so a retry storm cannot flood the log.
      const text =
        (message as AssistantMessage).errorMessage ?? "unknown error";
      const line = `session ${host.sessionId}: model call failed: ${text}`;
      if (decision.action === "park") log.debug(`${line} (retrying)`);
      else log.warn(line);
    }
  }

  /** Restart a run that a silent-error turn killed: the parked retry
   * notification becomes the next prompt once the dead run has fully
   * settled, so every run caller — prompt() (an awaited run) and the
   * fire-and-forget deliveries (web prompts, injected notifications) —
   * holds off reporting completion until the restart chain has finished.
   *
   * A restart parked by a context overflow condenses the history first: the
   * request that was rejected cannot be re-sent unchanged, so the forced
   * compaction (threshold and retention bypassed) runs here — after the dead
   * run settled, before the restart's first request. When nothing could be
   * freed the restart is dropped and the provider's own error stands, rather
   * than paying for a request that will be rejected again. */
  async resumeAfterErrorRun(): Promise<void> {
    const host = this.host;
    if (host.retry.hasPendingOverflow) {
      const result = await host.compaction.compactForOverflow();
      if (result === null) {
        host.retry.clearPendingRestart();
        return;
      }
    }
    await host.retry.resumeOnce(host.agent, host.isClosed());
  }
}
