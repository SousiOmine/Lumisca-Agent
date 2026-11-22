/**
 * The calls the agent's tools make into a lent folder: one frame out, one
 * answer back.
 *
 * The folder is on somebody else's machine, so a call can fail in ways a local
 * file call cannot — the app went away mid-read, the answer never came, the
 * caller's run was stopped. All of that is settled here, once, so the backends
 * above never see a hung promise and the tool's error message is written in
 * one place.
 *
 * A result carries the id the call was made with, so a late answer to an
 * abandoned call settles nothing (a reconnected app must not answer an old
 * call down its new socket).
 */

import type { ShareCall, ShareOpMap, ShareOpName, ShareResult } from "./ops.ts";
import { SHARE_EXEC_GRACE_MS, SHARE_OP_TIMEOUT_MS } from "./ops.ts";
import type { ShareSink } from "./registry.ts";

interface PendingCall {
  sink: ShareSink;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** Undo the abort listener when the call settles either way. */
  detach?(): void;
}

export class ShareCallBroker {
  readonly #pending = new Map<string, PendingCall>();
  /** How long a file call may take before the loan is treated as wedged;
   * tests shorten it (the production values are in share/ops.ts). */
  readonly #opTimeoutMs: number;
  readonly #execGraceMs: number;

  constructor(options: { opTimeoutMs?: number; execGraceMs?: number } = {}) {
    this.#opTimeoutMs = options.opTimeoutMs ?? SHARE_OP_TIMEOUT_MS;
    this.#execGraceMs = options.execGraceMs ?? SHARE_EXEC_GRACE_MS;
  }

  /**
   * Call `op` in the grant's folder through `owner`, the connection that
   * announced it. A grant nobody owns anymore never gets here: the caller
   * asks the registry first, and its refusal says to lend the folder again.
   */
  async call<K extends ShareOpName>(
    owner: ShareSink,
    op: K,
    request: ShareOpMap[K]["req"],
    grantId: string,
    signal?: AbortSignal,
  ): Promise<ShareResult<K>> {
    if (signal?.aborted === true) {
      throw new Error("The operation was stopped before the folder answered");
    }
    const id = crypto.randomUUID();
    const call = { op, ...request } as unknown as ShareCall;
    const timeoutMs =
      op === "exec"
        ? (request as ShareOpMap["exec"]["req"]).timeoutSec * 1000 +
          this.#execGraceMs
        : this.#opTimeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        // The host kills the process on `cancel`; the caller does not wait
        // for that acknowledgement (the run is already stopping).
        owner.send({ type: "cancel", id });
        reject(new Error("The operation was stopped"));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        owner.send({ type: "cancel", id });
        reject(
          new Error(
            `The computer that lent the folder did not answer within ${Math.round(
              timeoutMs / 1000,
            )}s`,
          ),
        );
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        sink: owner,
        resolve,
        reject,
        timer,
        detach: () => signal?.removeEventListener("abort", onAbort),
      });
    });
    try {
      owner.send({ type: "op", id, grant: grantId, call });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.detach?.();
      }
      throw new Error(
        `Could not reach the computer that lent the folder: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return (await promise) as ShareResult<K>;
  }

  /** One answer from a lending app. Results carry the id the call was made
   * with, so a late answer to an abandoned call settles nothing. */
  settle(
    sink: ShareSink,
    frame:
      | { type: "result"; id: string; ok: true; value: unknown }
      | { type: "result"; id: string; ok: false; error: string },
  ): void {
    const pending = this.#pending.get(frame.id);
    // A result from a connection that no longer owns the call is a reconnect
    // answering an old one: dropping it is what keeps two app runs from
    // settling each other's work.
    if (pending === undefined || pending.sink !== sink) return;
    this.#pending.delete(frame.id);
    pending.detach?.();
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(new Error(frame.error));
  }

  /** Fail every call in flight on one connection: its app is gone, and a
   * promise that never settles would hold the run that made the call. */
  failCallsOf(sink: ShareSink, message: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sink !== sink) continue;
      this.#pending.delete(id);
      pending.detach?.();
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
  }

  /** Settle everything and forget it (the server is closing). */
  close(message: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.detach?.();
      this.#pending.delete(id);
      pending.reject(new Error(message));
    }
  }
}
