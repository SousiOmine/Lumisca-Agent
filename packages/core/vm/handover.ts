/**
 * Handing the machine's screen over to the user.
 *
 * Some steps cannot be done by the agent and must not be done by it either:
 * typing a password, solving a CAPTCHA, approving a login in a window it
 * cannot read. The agent's way out is to ask, and then to stop — the run
 * blocks inside the tool call while the user drives the screen in the
 * browser, and continues once they say they are done.
 *
 * The alternative (telling the model to "try again later") does not work:
 * the agent would keep clicking a screen the user is trying to use, and the
 * two pointers would fight. So the wait is real: the tool call does not
 * return until the user finishes, the wait's deadline passes, the run is
 * aborted, or the session closes.
 *
 * The deadline is what keeps an absent user from stopping the conversation
 * for good: the run would otherwise stay streaming forever, and every
 * routine of the same agent would queue behind it. It ends the wait the
 * same way a cancel does (the pane stops being interactive first) and
 * hands the run back a `timed_out` outcome, so the model chooses another
 * way instead of the run being killed.
 *
 * One handover per session at a time: a single run is what asks, and a
 * second simultaneous request would mean two people on one screen.
 */
import { CoreError } from "../errors.ts";
import { abortError } from "../shared/misc.ts";
import type { ClientEvent } from "../types/event.ts";

/** How long the agent waits at the screen before it continues without the
 * user. Long enough for a password reset or a CAPTCHA in another window,
 * short enough that a forgotten hand-over does not hold the conversation
 * (and the agent's queued routines) for the rest of the day. */
export const HANDOVER_TIMEOUT_MS = 15 * 60_000;

/** How a wait ended: the user finished at the screen, or nobody came
 * before the deadline. */
export type HandoverOutcome =
  | { kind: "finished"; note: string }
  | { kind: "timed_out" };

/** A handover the user has not finished yet, as the resync snapshot carries
 * it (`handover` events are never replayed, so a client that (re)connects
 * while the run is blocked has no other way to learn about it). */
export interface PendingHandover {
  toolCallId: string;
  /** Why the agent needs the user at the screen. */
  reason: string;
  /** What it wants them to do, when it said more than the reason. */
  instructions: string | null;
  /** When the wait ends on its own (epoch ms). A client that reconnected
   * mid-wait has no other way to know how long is left. */
  expiresAt: number;
}

interface Waiting extends PendingHandover {
  resolve: (outcome: HandoverOutcome) => void;
  reject: (error: Error) => void;
}

/**
 * Owns the handover of one session. The tool registers here and awaits the
 * returned promise; `finish()` resolves it with what the user reported
 * doing (possibly nothing).
 *
 * The lifecycle is bound to the session's run: the agent tears every
 * pending handover down when its run ends or the session closes, so a
 * handover can never outlive the run that asked for it (the screen would
 * stay interactive with nothing waiting for it). The deadline is the third
 * way out, for a user who never comes (see `wait`).
 */
export class HandoverHub {
  private pending: Waiting | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ClientEvent) => void,
    /** Overridable so a test can watch a deadline pass without waiting a
     * quarter of an hour. */
    private readonly timeoutMs: number = HANDOVER_TIMEOUT_MS,
  ) {}

  /**
   * Ask the user to take over the screen and wait for them.
   *
   * Resolves with how the wait ended: the user's note (an empty string when
   * they said nothing beyond "done"), or `timed_out` when the deadline
   * passed first. Rejects when the run is torn down first — an abort, a
   * rewind, or the session closing — so no tool call can hang past the run
   * that asked it.
   */
  wait(
    toolCallId: string,
    reason: string,
    instructions: string | null,
    signal?: AbortSignal,
  ): Promise<HandoverOutcome> {
    if (this.pending !== null) {
      return Promise.reject(
        new CoreError(
          "The user is already being asked to take over the screen",
          "conflict",
        ),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    const expiresAt = Date.now() + this.timeoutMs;
    this.emit({
      type: "handover",
      sessionId: this.sessionId,
      toolCallId,
      reason,
      instructions,
      expiresAt,
    });
    return new Promise<HandoverOutcome>((resolve, reject) => {
      // Every way out (finish, abort, cancel, deadline) runs through here,
      // so a settled wait never leaves a timer behind to close a LATER
      // hand-over.
      const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (this.pending?.toolCallId !== toolCallId) return;
        this.pending = null;
        release();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        // The wait may already have been settled (or replaced) by the time
        // a stale timer fires; only the hand-over that set this timer may
        // be closed here.
        if (this.pending?.toolCallId !== toolCallId) return;
        this.pending = null;
        release();
        // Close the interaction BEFORE the run moves on: the user may be
        // at the screen right now, and the agent must not start clicking
        // while the pane still accepts their input.
        this.emit({
          type: "handover_end",
          sessionId: this.sessionId,
          toolCallId,
          note: "",
        });
        resolve({ kind: "timed_out" });
      }, this.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        toolCallId,
        reason,
        instructions,
        expiresAt,
        resolve: (outcome) => {
          release();
          resolve(outcome);
        },
        reject: (error) => {
          release();
          reject(error);
        },
      };
    });
  }

  /** The handover still waiting for the user, or null. */
  pendingHandover(): PendingHandover | null {
    if (this.pending === null) return null;
    return {
      toolCallId: this.pending.toolCallId,
      reason: this.pending.reason,
      instructions: this.pending.instructions,
      expiresAt: this.pending.expiresAt,
    };
  }

  /**
   * The user finished at the screen: let the blocked run continue, telling
   * it what they did (an empty note when they only pressed "done").
   *
   * Throws when nothing is waiting, so the HTTP layer can answer 409
   * instead of silently accepting a stale click.
   */
  finish(note: string, toolCallId?: string): void {
    const pending = this.pending;
    if (pending === null) {
      throw new CoreError("No handover is waiting for the user", "not_found");
    }
    if (toolCallId !== undefined && toolCallId !== pending.toolCallId) {
      throw new CoreError(
        `No handover is waiting for tool call: ${toolCallId}`,
        "not_found",
      );
    }
    this.pending = null;
    this.emit({
      type: "handover_end",
      sessionId: this.sessionId,
      toolCallId: pending.toolCallId,
      note,
    });
    pending.resolve({ kind: "finished", note });
  }

  /** Reject the pending handover. Called when the run ends or the session
   * closes, so a torn-down run cannot leave the wait hanging (or the
   * screen interactive with nothing behind it). Idempotent. */
  cancelAll(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.emit({
      type: "handover_end",
      sessionId: this.sessionId,
      toolCallId: pending.toolCallId,
      note: "",
    });
    pending.reject(
      new CoreError("The handover was cancelled", "unavailable"),
    );
  }
}
