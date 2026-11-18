/**
 * Asking the user for a value the agent must not see.
 *
 * `vm_env` names a variable; the user types its value in a card in the
 * conversation. The value goes from the input straight into the machine (see
 * env-store.ts) and the run resumes with "it is set" — never with the value.
 * The wait is real, for the same reason the screen hand-over's is: the tool
 * call does not return until the user answers, declines, the deadline
 * passes, or the run is torn down.
 *
 * One request per session at a time, like the hand-over: two cards would
 * be two questions with one run behind them, and nothing says which answer
 * belongs to which call.
 *
 * The deadline is what keeps an absent user from parking the conversation:
 * past it, the run is handed back a `timed_out` outcome so the model chooses
 * another way instead of the run being killed (a conversation blocked
 * forever also blocks the same agent's routines).
 */

import type { ClientEvent } from "../domain/event.ts";
import { CoreError } from "../errors.ts";
import { HubRegistry } from "../interruptions/hub-registry.ts";
import { PendingRequest } from "../interruptions/pending-request.ts";

/** How long the card stays before the run continues without a value.
 * The same 15 minutes the screen hand-over waits: long enough to fetch a key
 * from somewhere else, short enough that a forgotten card does not hold
 * the conversation for the rest of the day. */
export const ENV_REQUEST_TIMEOUT_MS = 15 * 60_000;

/** How the wait ended: the value was stored, the user declined, or nobody
 * answered before the deadline. */
export type EnvRequestOutcome =
  | { kind: "set" }
  | { kind: "declined" }
  | { kind: "timed_out" };

/** A request the user has not answered yet, as the resync snapshot carries
 * it (`env_request` events are never replayed, so a client that (re)connects
 * while the run is blocked has no other way to learn about it). */
export interface PendingEnvRequest {
  toolCallId: string;
  /** The variable the agent named. */
  name: string;
  /** Whether the name already has a value: the card says the entry will
   * be replaced, so the user knows they are not adding a second one. */
  exists: boolean;
  /** When the wait ends on its own (epoch ms). */
  expiresAt: number;
}

/**
 * Owns the environment-variable request of one session. The tool asks here
 * and awaits the returned promise; the HTTP route answers it once the value
 * has been written into the machine.
 *
 * The lifecycle is bound to the session's run: the agent tears every pending
 * request down when its run ends or the session closes, so a request can
 * never outlive the run that asked it (a card would stay with
 * nothing waiting behind it).
 */
export class EnvRequestHub {
  private readonly request: PendingRequest<
    PendingEnvRequest,
    EnvRequestOutcome
  >;
  private readonly sessionId: string;
  private readonly emit: (event: ClientEvent) => void;
  private readonly timeoutMs: number;

  constructor(
    sessionId: string,
    emit: (event: ClientEvent) => void,
    /** Overridable so a test can watch a deadline pass without waiting a
     * quarter of an hour. */
    timeoutMs: number = ENV_REQUEST_TIMEOUT_MS,
  ) {
    this.sessionId = sessionId;
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    this.request = new PendingRequest<PendingEnvRequest, EnvRequestOutcome>({
      cancelled: "The environment variable request was cancelled",
      // Remove the card BEFORE the run moves on: the user may be typing
      // right now, and a value arriving afterwards has nowhere to go.
      onTimeout: (pending) => {
        this.emit({
          type: "env_request_end",
          sessionId: this.sessionId,
          toolCallId: pending.toolCallId,
          outcome: "timed_out",
        });
        return { kind: "timed_out" };
      },
    });
  }

  /**
   * Ask the user for `name`'s value and wait for the answer.
   *
   * Rejects when the run is torn down first (an abort, a rewind, the session
   * closing), so no tool call can hang past the run that asked it.
   */
  ask(
    toolCallId: string,
    name: string,
    exists: boolean,
    signal?: AbortSignal,
  ): Promise<EnvRequestOutcome> {
    return this.request.open(
      { toolCallId, name, exists, expiresAt: Date.now() + this.timeoutMs },
      {
        timeoutMs: this.timeoutMs,
        signal,
        context: undefined,
        conflict: "The user is already being asked for an environment variable",
        announce: (pending) => {
          this.emit({
            type: "env_request",
            sessionId: this.sessionId,
            toolCallId: pending.toolCallId,
            name: pending.name,
            exists: pending.exists,
            expiresAt: pending.expiresAt,
          });
        },
      },
    );
  }

  /** The request still waiting for the user, or null. */
  pendingEnvRequest(): PendingEnvRequest | null {
    return this.request.pending();
  }

  /**
   * The value is stored: let the blocked run continue.
   *
   * The caller has already written it into the machine, so a rejected write
   * leaves the request waiting (the card still shows its error) instead of
   * telling the agent a variable exists that does not.
   *
   * Throws when nothing is waiting, so the HTTP layer can answer 404/409
   * instead of silently accepting a stale answer.
   */
  finish(toolCallId?: string): void {
    const taken = this.request.take(
      toolCallId,
      "No environment variable is waiting for the user",
    );
    this.emit({
      type: "env_request_end",
      sessionId: this.sessionId,
      toolCallId: taken.payload.toolCallId,
      outcome: "set",
    });
    taken.settle({ kind: "set" });
  }

  /** The user pressed the button that declines. The run continues without a
   * value; it is not an error. */
  decline(toolCallId?: string): void {
    const taken = this.request.take(
      toolCallId,
      "No environment variable is waiting for the user",
    );
    this.emit({
      type: "env_request_end",
      sessionId: this.sessionId,
      toolCallId: taken.payload.toolCallId,
      outcome: "declined",
    });
    taken.settle({ kind: "declined" });
  }

  /** Reject the pending request. Called when the run ends or the session
   * closes, so a torn-down run cannot leave the wait hanging (or the card
   * up with nothing behind it). Idempotent. */
  cancelAll(): void {
    const taken = this.request.takeIfPresent();
    if (taken === null) return;
    this.emit({
      type: "env_request_end",
      sessionId: this.sessionId,
      toolCallId: taken.payload.toolCallId,
      outcome: "declined",
    });
    taken.fail(
      new CoreError(
        "The environment variable request was cancelled",
        "unavailable",
      ),
    );
  }
}

/**
 * The request hub of each session that ever asked for a value.
 *
 * The same ownership rule as the hand-over registry: the core's close, delete
 * and shutdown paths drop a session's hub by calling {@link forget} instead
 * of reaching into a map the facade happens to hold. Hubs are created on
 * demand: a session that never asks has no entry.
 */
export class EnvRequestRegistry {
  private readonly hubs: HubRegistry<EnvRequestHub>;

  /** `emit` publishes the hub's events to every frontend listener. */
  constructor(emit: (event: ClientEvent) => void) {
    this.hubs = new HubRegistry(
      (sessionId) => new EnvRequestHub(sessionId, emit),
    );
  }

  for(sessionId: string): EnvRequestHub {
    return this.hubs.for(sessionId);
  }

  get(sessionId: string): EnvRequestHub | undefined {
    return this.hubs.get(sessionId);
  }

  forget(sessionId: string): void {
    this.hubs.forget(sessionId);
  }

  sessionIds(): Iterable<string> {
    return this.hubs.sessionIds();
  }
}
