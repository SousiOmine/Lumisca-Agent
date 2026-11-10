/**
 * Asking the user for a value the agent must not see.
 *
 * `vm_env` names a variable; the user types its value in a dialog in the
 * browser. The value goes from the input straight into the machine (see
 * env-store.ts) and the run resumes with "it is set" — never with the value.
 * The wait is real, for the same reason the screen hand-over's is: the tool
 * call does not return until the user answers, declines, the deadline
 * passes, or the run is torn down.
 *
 * One request per session at a time, like the hand-over: two dialogs would
 * be two questions with one run behind them, and nothing says which answer
 * belongs to which call.
 *
 * The deadline is what keeps an absent user from parking the conversation:
 * past it, the run is handed back a `timed_out` outcome so the model chooses
 * another way instead of the run being killed (a conversation blocked
 * forever also blocks the same agent's routines).
 */
import { CoreError } from "../errors.ts";
import { abortError } from "../shared/misc.ts";
import type { ClientEvent } from "../domain/event.ts";

/** How long the dialog stays up before the run continues without a value.
 * The same 15 minutes the screen hand-over waits: long enough to fetch a key
 * from somewhere else, short enough that a forgotten dialog does not hold
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
  /** Whether the name already has a value: the dialog says the entry will
   * be replaced, so the user knows they are not adding a second one. */
  exists: boolean;
  /** When the wait ends on its own (epoch ms). */
  expiresAt: number;
}

interface Waiting extends PendingEnvRequest {
  resolve: (outcome: EnvRequestOutcome) => void;
  reject: (error: Error) => void;
}

/**
 * Owns the environment-variable request of one session. The tool asks here
 * and awaits the returned promise; the HTTP route answers it once the value
 * has been written into the machine.
 *
 * The lifecycle is bound to the session's run: the agent tears every pending
 * request down when its run ends or the session closes, so a request can
 * never outlive the run that asked for it (a dialog would stay up with
 * nothing waiting behind it).
 */
export class EnvRequestHub {
  private pending: Waiting | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ClientEvent) => void,
    /** Overridable so a test can watch a deadline pass without waiting a
     * quarter of an hour. */
    private readonly timeoutMs: number = ENV_REQUEST_TIMEOUT_MS,
  ) {}

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
    if (this.pending !== null) {
      return Promise.reject(
        new CoreError(
          "The user is already being asked for an environment variable",
          "conflict",
        ),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    const expiresAt = Date.now() + this.timeoutMs;
    this.emit({
      type: "env_request",
      sessionId: this.sessionId,
      toolCallId,
      name,
      exists,
      expiresAt,
    });
    return new Promise<EnvRequestOutcome>((resolve, reject) => {
      // Every way out (answer, decline, abort, deadline) runs through here,
      // so a settled wait never leaves a timer behind to close a LATER
      // request.
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
        // a stale timer fires; only the request that set this timer may be
        // closed here.
        if (this.pending?.toolCallId !== toolCallId) return;
        this.pending = null;
        release();
        // Close the dialog BEFORE the run moves on: the user may be typing
        // right now, and a value arriving afterwards has nowhere to go.
        this.emit({
          type: "env_request_end",
          sessionId: this.sessionId,
          toolCallId,
          outcome: "timed_out",
        });
        resolve({ kind: "timed_out" });
      }, this.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        toolCallId,
        name,
        exists,
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

  /** The request still waiting for the user, or null. */
  pendingEnvRequest(): PendingEnvRequest | null {
    if (this.pending === null) return null;
    return {
      toolCallId: this.pending.toolCallId,
      name: this.pending.name,
      exists: this.pending.exists,
      expiresAt: this.pending.expiresAt,
    };
  }

  /**
   * The value is stored: let the blocked run continue.
   *
   * The caller has already written it into the machine, so a rejected write
   * leaves the request waiting (the dialog still shows its error) instead of
   * telling the agent a variable exists that does not.
   *
   * Throws when nothing is waiting, so the HTTP layer can answer 404/409
   * instead of silently accepting a stale dialog.
   */
  finish(toolCallId?: string): void {
    const pending = this.#take(toolCallId);
    this.emit({
      type: "env_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.toolCallId,
      outcome: "set",
    });
    pending.resolve({ kind: "set" });
  }

  /** The user refused (or closed the dialog). The run continues without a
   * value; it is not an error. */
  decline(toolCallId?: string): void {
    const pending = this.#take(toolCallId);
    this.emit({
      type: "env_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.toolCallId,
      outcome: "declined",
    });
    pending.resolve({ kind: "declined" });
  }

  /** Reject the pending request. Called when the run ends or the session
   * closes, so a torn-down run cannot leave the wait hanging (or the dialog
   * up with nothing behind it). Idempotent. */
  cancelAll(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.emit({
      type: "env_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.toolCallId,
      outcome: "declined",
    });
    pending.reject(
      new CoreError(
        "The environment variable request was cancelled",
        "unavailable",
      ),
    );
  }

  /** Take the pending request out, or throw when it is not the one named. */
  #take(toolCallId: string | undefined): Waiting {
    const pending = this.pending;
    if (pending === null) {
      throw new CoreError(
        "No environment variable is waiting for the user",
        "not_found",
      );
    }
    if (toolCallId !== undefined && toolCallId !== pending.toolCallId) {
      throw new CoreError(
        `No environment variable is waiting for tool call: ${toolCallId}`,
        "not_found",
      );
    }
    this.pending = null;
    return pending;
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
  private readonly hubs = new Map<string, EnvRequestHub>();

  /** `emit` publishes the hub's events to every frontend listener. */
  constructor(private readonly emit: (event: ClientEvent) => void) {}

  /** The hub of a session, created on first use. */
  for(sessionId: string): EnvRequestHub {
    const existing = this.hubs.get(sessionId);
    if (existing !== undefined) return existing;
    const hub = new EnvRequestHub(sessionId, (event) => this.emit(event));
    this.hubs.set(sessionId, hub);
    return hub;
  }

  /** The hub of a session only if it exists (no entry is created: reading
   * the pending request of a session that never asked must not). */
  get(sessionId: string): EnvRequestHub | undefined {
    return this.hubs.get(sessionId);
  }

  /** Drop a session's hub (the session is gone). */
  forget(sessionId: string): void {
    this.hubs.delete(sessionId);
  }

  /** The sessions that have a hub (the shutdown sweep). */
  sessionIds(): Iterable<string> {
    return this.hubs.keys();
  }
}
