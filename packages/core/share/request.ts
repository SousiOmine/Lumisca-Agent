/**
 * The two ways an agent asks the user about a lent folder: "may I use one?"
 * and "I am done with this one".
 *
 * Neither can be answered by the server alone. Lending starts with the OS
 * folder picker, which only the desktop shell can show; ending a loan is the
 * shell's call too, because the shell — not the server — is what tells the
 * lending child which folders it may serve (see packages/desktop/src-tauri/
 * src/share.rs). The page in front of the user is the one channel both have,
 * so the request travels as an event to it and the answer posts back to the
 * conversation's share endpoints.
 *
 * The first request BLOCKS the run, like `vm_env` and the screen hand-over do:
 * the tool call returns only once the user has lent something, refused, or the
 * deadline passed. The second blocks for seconds at most, because the page
 * answers it without asking anybody — see `askDisconnect`.
 *
 * One request per session at a time: two cards would be two questions with one
 * run behind them, and nothing says which answer belongs to which call.
 *
 * The deadline is what keeps an absent user from parking the conversation: a
 * conversation blocked forever also blocks the same agent's routines.
 */

import type { ClientEvent } from "../domain/event.ts";
import { CoreError } from "../errors.ts";
import { abortError } from "../shared/misc.ts";

/** How long the lending card stays before the run continues without a
 * folder. The same 15 minutes the screen hand-over waits: long enough to
 * decide what to lend and where it is, short enough that a forgotten card
 * does not hold the conversation for the rest of the day. */
export const SHARE_LEND_TIMEOUT_MS = 15 * 60_000;

/** How long the server waits for the desktop app to withdraw a loan.
 *
 * Nobody is asked anything here: the page forwards the request to the shell
 * and posts the answer. The wait exists only to learn that the shell never
 * answered (the app closed, the page went away), and to hand the model a
 * reason instead of a tool call that never returns. */
export const SHARE_DISCONNECT_TIMEOUT_MS = 30_000;

/** How a wait ended. `lent` and `disconnected` are the outcomes the tools
 * turn into words; `failed` carries the desktop app's own reason. */
export type ShareRequestOutcome =
  | { kind: "lent" }
  | { kind: "declined" }
  | { kind: "disconnected" }
  | { kind: "failed"; error: string }
  | { kind: "timed_out" };

/** A request the user has not answered yet, as the resync snapshot carries
 * it: `share_request` events are never replayed, so a client that
 * (re)connects while the run is blocked has no other way to learn about it. */
export type PendingShareRequest =
  | {
      kind: "lend";
      toolCallId: string;
      /** Why the agent needs a folder, in its own words: the card shows it,
       * and it is the one thing a reader of the card cannot guess. */
      reason: string;
      /** When the wait ends on its own (epoch ms). */
      expiresAt: number;
    }
  | {
      kind: "disconnect";
      toolCallId: string;
      /** The grant's id: what the page passes to the shell's
       * `share/revoke`. */
      id: string;
      /** The folder's name in the namespace (`/lend/<name>`), for the
       * client's own bookkeeping. */
      name: string;
      expiresAt: number;
    };

interface Waiting {
  request: PendingShareRequest;
  /** The grants that were already lent when a lend request was asked: a
   * loan that was there before the request is not an answer to it. */
  known: readonly string[];
  resolve: (outcome: ShareRequestOutcome) => void;
  reject: (error: Error) => void;
}

/**
 * Owns the share requests of one session. The tools ask here and await the
 * returned promise; the HTTP routes answer once the user (or their computer)
 * has done something about it.
 *
 * The lifecycle is bound to the session's run: the agent tears every pending
 * request down when its run ends or the session closes, so a card can never
 * stay up with nothing waiting behind it.
 */
export class ShareRequestHub {
  private pending: Waiting | null = null;
  /** Overridable so a test can watch a deadline pass without waiting a
   * quarter of an hour (the production values are the constants above). */
  private readonly lendTimeoutMs: number;
  private readonly disconnectTimeoutMs: number;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ClientEvent) => void,
    timeouts: { lend?: number; disconnect?: number } = {},
  ) {
    this.lendTimeoutMs = timeouts.lend ?? SHARE_LEND_TIMEOUT_MS;
    this.disconnectTimeoutMs =
      timeouts.disconnect ?? SHARE_DISCONNECT_TIMEOUT_MS;
  }

  /**
   * Ask the user to lend a folder and wait for the answer.
   *
   * `known` is the grant ids already lent to this session: an announcement
   * that still shows only those is not an answer to this request.
   *
   * Rejects when the run is torn down first (an abort, a rewind, the session
   * closing), so no tool call can hang past the run that asked it.
   */
  askLend(
    toolCallId: string,
    reason: string,
    known: readonly string[],
    signal?: AbortSignal,
  ): Promise<ShareRequestOutcome> {
    const request: PendingShareRequest = {
      kind: "lend",
      toolCallId,
      reason,
      expiresAt: Date.now() + this.lendTimeoutMs,
    };
    return this.#ask(request, known, this.lendTimeoutMs, signal);
  }

  /**
   * Ask the desktop app to withdraw a loan and wait for it to be gone.
   *
   * Nothing is put in front of the user: the page forwards this to the shell
   * and posts the result. The wait is short because the only thing it can
   * learn late is that the app is not there.
   */
  askDisconnect(
    toolCallId: string,
    grant: { id: string; name: string },
    signal?: AbortSignal,
  ): Promise<ShareRequestOutcome> {
    const request: PendingShareRequest = {
      kind: "disconnect",
      toolCallId,
      id: grant.id,
      name: grant.name,
      expiresAt: Date.now() + this.disconnectTimeoutMs,
    };
    return this.#ask(request, [], this.disconnectTimeoutMs, signal);
  }

  #ask(
    request: PendingShareRequest,
    known: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ShareRequestOutcome> {
    if (this.pending !== null) {
      return Promise.reject(
        new CoreError(
          "The user is already being asked about a lent folder",
          "conflict",
        ),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    this.emit({
      type: "share_request",
      sessionId: this.sessionId,
      toolCallId: request.toolCallId,
      ...(request.kind === "lend"
        ? { kind: "lend", reason: request.reason }
        : { kind: "disconnect", id: request.id, name: request.name }),
      expiresAt: request.expiresAt,
    });
    return new Promise<ShareRequestOutcome>((resolve, reject) => {
      // Every way out (answer, decline, abort, deadline) runs through here,
      // so a settled wait never leaves a timer behind to close a LATER
      // request.
      const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (this.pending?.request.toolCallId !== request.toolCallId) return;
        this.pending = null;
        release();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        // The wait may already have been settled (or replaced) by the time a
        // stale timer fires; only the request that set this timer may be
        // closed here.
        if (this.pending?.request.toolCallId !== request.toolCallId) return;
        this.pending = null;
        release();
        // Remove the card BEFORE the run moves on: the user may be choosing
        // a folder right now, and a loan made afterwards would answer
        // nothing.
        this.emit({
          type: "share_request_end",
          sessionId: this.sessionId,
          toolCallId: request.toolCallId,
          outcome: "timed_out",
        });
        resolve({ kind: "timed_out" });
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        request,
        known,
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
  pendingShareRequest(): PendingShareRequest | null {
    return this.pending?.request ?? null;
  }

  /**
   * The user lent a folder: let the blocked run continue.
   *
   * Called from the card's answer and, for a loan made anywhere else (the
   * composer's menu), from the announcement itself.
   *
   * Throws when no lend request is waiting, so the HTTP layer can answer
   * 404/409 instead of silently accepting a stale answer.
   */
  finishLend(toolCallId?: string): void {
    const pending = this.#take("lend", toolCallId);
    this.emit({
      type: "share_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.request.toolCallId,
      outcome: "lent",
    });
    pending.resolve({ kind: "lent" });
  }

  /** The user pressed the button that declines. The run continues without a
   * folder; it is not an error. */
  decline(toolCallId?: string): void {
    const pending = this.#take("lend", toolCallId);
    this.emit({
      type: "share_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.request.toolCallId,
      outcome: "declined",
    });
    pending.resolve({ kind: "declined" });
  }

  /** The desktop app withdrew the loan. */
  finishDisconnect(toolCallId?: string): void {
    const pending = this.#take("disconnect", toolCallId);
    this.emit({
      type: "share_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.request.toolCallId,
      outcome: "disconnected",
    });
    pending.resolve({ kind: "disconnected" });
  }

  /** The desktop app could not withdraw it, and said why. The loan is still
   * there: the words go into the tool's result as they were given. */
  failDisconnect(toolCallId: string, error: string): void {
    const pending = this.#take("disconnect", toolCallId);
    this.emit({
      type: "share_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.request.toolCallId,
      outcome: "failed",
    });
    pending.resolve({ kind: "failed", error });
  }

  /**
   * The session's loans changed: answer whatever that settles.
   *
   * A lend request is answered by a grant that was not there when it was
   * asked (the user may have lent it from the composer's menu instead of the
   * card), and a disconnect request by its grant being gone. `grants` is the
   * server's own list, so this is the truth rather than a claim by a client.
   */
  settleFromGrants(grants: readonly { id: string }[]): void {
    const pending = this.pending;
    if (pending === null) return;
    const ids = grants.map((grant) => grant.id);
    if (pending.request.kind === "lend") {
      if (ids.some((id) => !pending.known.includes(id))) {
        this.finishLend(pending.request.toolCallId);
      }
      return;
    }
    if (!ids.includes(pending.request.id)) {
      this.finishDisconnect(pending.request.toolCallId);
    }
  }

  /** Reject the pending request. Called when the run ends or the session
   * closes, so a torn-down run cannot leave the wait hanging. Idempotent. */
  cancelAll(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.emit({
      type: "share_request_end",
      sessionId: this.sessionId,
      toolCallId: pending.request.toolCallId,
      outcome: "declined",
    });
    pending.reject(
      new CoreError("The folder request was cancelled", "unavailable"),
    );
  }

  /** Take the pending request out, or throw when it is not the one named (or
   * is of the other kind: a card can only answer the question it shows). */
  #take(
    kind: PendingShareRequest["kind"],
    toolCallId: string | undefined,
  ): Waiting {
    const pending = this.pending;
    if (pending === null || pending.request.kind !== kind) {
      throw new CoreError(
        kind === "lend"
          ? "No folder is waiting to be lent"
          : "No lent folder is waiting to be withdrawn",
        "not_found",
      );
    }
    if (toolCallId !== undefined && toolCallId !== pending.request.toolCallId) {
      throw new CoreError(
        `No folder request is waiting for tool call: ${toolCallId}`,
        "not_found",
      );
    }
    this.pending = null;
    return pending;
  }
}

/**
 * The request hub of each session that ever asked for a folder.
 *
 * The same ownership rule as the environment-variable registry: the core's
 * close, delete and shutdown paths drop a session's hub by calling
 * {@link forget}. Hubs are created on demand, so a session that never asks
 * has no entry.
 */
export class ShareRequestRegistry {
  private readonly hubs = new Map<string, ShareRequestHub>();

  /** `emit` publishes the hubs' events to every frontend listener. */
  constructor(private readonly emit: (event: ClientEvent) => void) {}

  /** The hub of a session, created on first use. */
  for(sessionId: string): ShareRequestHub {
    const existing = this.hubs.get(sessionId);
    if (existing !== undefined) return existing;
    const hub = new ShareRequestHub(sessionId, (event) => this.emit(event));
    this.hubs.set(sessionId, hub);
    return hub;
  }

  /** The hub of a session only if it exists (no entry is created: reading
   * the pending request of a session that never asked must not). */
  get(sessionId: string): ShareRequestHub | undefined {
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
