/**
 * The wait behind an interruption: a tool call blocks until the user
 * answers, the deadline passes, the signal aborts, or the run is torn down.
 *
 * Four features ask this question (the screen hand-over, an environment
 * variable, a folder request, a disconnect) and each used to spell the same
 * timer and abort bookkeeping out by hand. The rules below are the ones that
 * took a bug to get right, so they live in one class:
 *
 * - one wait at a time; a second request is a conflict, not a queue;
 * - a deadline resolves with the hub's timed-out outcome, and the hub emits
 *   its end event at exactly that moment (a client that reconnects must not
 *   see a card that nothing is waiting behind);
 * - an abort rejects with the abort error and clears the timer;
 * - the identity guard compares the payload's `toolCallId`, so a stale timer
 *   from an earlier wait cannot settle a later one;
 * - taking the wait out first, then settling, so no path leaves a timer that
 *   closes a future request.
 */
import { CoreError } from "../errors.ts";
import { abortError } from "../shared/misc.ts";

/** What every interruption payload carries: the call that asked, and when
 * the wait ends on its own. */
export interface PendingPayload {
  toolCallId: string;
  expiresAt: number;
}

export interface PendingHandle<P, R, C> {
  payload: P;
  /** Hub-private state carried beside the payload (`known` grants, for
   * example). */
  context: C;
  settle(outcome: R): void;
  fail(error: Error): void;
}

export interface OpenOptions<P, C> {
  /** Per-call deadline: the folder hubs wait longer for a disconnect than
   * for a lend. */
  timeoutMs: number;
  signal?: AbortSignal;
  context: C;
  /** Message of the rejection when a wait is already pending. */
  conflict: string;
  /** Emits the request event. Called only when the wait was accepted. */
  announce(payload: P, context: C): void;
}

export class PendingRequest<P extends PendingPayload, R, C = undefined> {
  private current: {
    payload: P;
    context: C;
    resolve: (outcome: R) => void;
    reject: (error: Error) => void;
    release: () => void;
  } | null = null;

  /** `onTimeout` runs at the deadline: it emits the hub's end event and
   * returns the outcome the blocked call sees. */
  constructor(
    private readonly options: {
      onTimeout: (payload: P) => R;
      /** Message of the rejection when the run tears the wait down. */
      cancelled: string;
    },
  ) {}

  open(payload: P, options: OpenOptions<P, C>): Promise<R> {
    if (this.current !== null) {
      return Promise.reject(new CoreError(options.conflict, "conflict"));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    options.announce(payload, options.context);
    return new Promise<R>((resolve, reject) => {
      const release = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (this.current?.payload.toolCallId !== payload.toolCallId) return;
        this.current = null;
        release();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        // A stale timer must not close the wait that replaced it.
        if (this.current?.payload.toolCallId !== payload.toolCallId) return;
        this.current = null;
        release();
        resolve(this.options.onTimeout(payload));
      }, options.timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.current = {
        payload,
        context: options.context,
        resolve: (outcome) => {
          release();
          resolve(outcome);
        },
        reject: (error) => {
          release();
          reject(error);
        },
        release,
      };
    });
  }

  /** The wait still pending, as a client snapshot carries it. */
  pending(): P | null {
    return this.current?.payload ?? null;
  }

  /** The pending wait and the hub state carried beside it (the known grant
   * ids, for example). */
  pendingWithContext(): { payload: P; context: C } | null {
    if (this.current === null) return null;
    return { payload: this.current.payload, context: this.current.context };
  }

  /** Take the wait out. Throws when none is pending or the call differs, so
   * the HTTP layer can answer 404/409 instead of accepting a stale click. */
  take(
    toolCallId: string | undefined,
    notFound: string,
  ): PendingHandle<P, R, C> {
    const current = this.current;
    if (current === null) throw new CoreError(notFound, "not_found");
    if (toolCallId !== undefined && toolCallId !== current.payload.toolCallId) {
      throw new CoreError(`${notFound}: ${toolCallId}`, "not_found");
    }
    this.current = null;
    return handleOf(current);
  }

  /** The teardown path is idempotent: nothing waiting is not an error. */
  takeIfPresent(): PendingHandle<P, R, C> | null {
    const current = this.current;
    if (current === null) return null;
    this.current = null;
    return handleOf(current);
  }
}

function handleOf<P, R, C>(entry: {
  payload: P;
  context: C;
  resolve: (outcome: R) => void;
  reject: (error: Error) => void;
}): PendingHandle<P, R, C> {
  return {
    payload: entry.payload,
    context: entry.context,
    settle: (outcome) => entry.resolve(outcome),
    fail: (error) => entry.reject(error),
  };
}
