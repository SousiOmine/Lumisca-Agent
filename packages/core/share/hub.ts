/**
 * The server's view of the computers that lend folders, kept in memory only.
 *
 * The truth about a loan is the lending app's: it decides, expires and
 * withdraws, and every one of those arrives here as an announcement. That is
 * why nothing is stored — a folder is lent for minutes, and a row that
 * outlived the app would promise an agent a folder nobody is serving. A
 * disconnect is therefore not a failure to report but the end of the loan,
 * which is the same thing the user sees when they quit the app.
 *
 * The hub is also the transport (see share/ops.ts `ShareTransport`): a file
 * operation becomes one frame with an id, and the answer is matched back to
 * the caller. Everything that can go wrong with a remote call — a timeout, the
 * caller's abort, the app going away mid-read — is settled here, once, so the
 * backends above never see a hung promise.
 */
import type { FolderShare, ShareHostInfo } from "../domain/share.ts";
import { type FolderGrant, isShareName, shareNameFrom } from "./grant.ts";
import {
  SHARE_EXEC_GRACE_MS,
  SHARE_OP_TIMEOUT_MS,
  type ShareCall,
  type ShareOpMap,
  type ShareOpName,
  type ShareServerFrame,
  type ShareTransport,
} from "./ops.ts";

/** Where the hub writes to reach one lending app. The server's route owns the
 * socket; the hub only hands it frames. */
export interface ShareSink {
  send(frame: ShareServerFrame): void;
  /** Close the app's socket (a reconnecting app replaces its own
   * connection; the stale socket must not linger). */
  close?(code?: number, reason?: string): void;
}

/** What one lending app told the hub about itself. */
export interface ShareConnectionInfo {
  clientId: string;
  host: ShareHostInfo;
  grants: FolderGrant[];
}

interface ConnectionState extends ShareConnectionInfo {
  sink: ShareSink;
}

interface PendingCall {
  sink: ShareSink;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** Undo the abort listener when the call settles either way. */
  detach?(): void;
}

export class ShareHub implements ShareTransport {
  readonly #connections = new Map<ShareSink, ConnectionState>();
  /** The app run (clientId) to its live connection: a reconnecting app
   * replaces its own entry instead of appearing as a second computer. */
  readonly #byClient = new Map<string, ShareSink>();
  /** Grant id to the connection that owns it: one lookup per file operation. */
  readonly #byGrant = new Map<string, ShareSink>();
  readonly #pending = new Map<string, PendingCall>();
  readonly #listeners = new Set<(sessionIds: readonly string[]) => void>();
  /** How long a file call may take before the loan is treated as wedged;
   * tests shorten it (the production values are in share/ops.ts). */
  readonly #opTimeoutMs: number;
  readonly #execGraceMs: number;

  constructor(options: { opTimeoutMs?: number; execGraceMs?: number } = {}) {
    this.#opTimeoutMs = options.opTimeoutMs ?? SHARE_OP_TIMEOUT_MS;
    this.#execGraceMs = options.execGraceMs ?? SHARE_EXEC_GRACE_MS;
  }

  /**
   * Record what an app says it is lending. Called for the first frame and for
   * every change; the previous grants of the same app run are replaced
   * wholesale, because an announcement is always the complete list (a partial
   * one could not express a withdrawal).
   *
   * Returns the sink this app run was connected through before, so the route
   * can close the stale socket of a reconnect.
   */
  register(sink: ShareSink, info: ShareConnectionInfo): ShareSink | undefined {
    const previous = this.#byClient.get(info.clientId);
    if (previous !== undefined && previous !== sink) {
      this.disconnect(previous);
    }
    const before = this.#connections.get(sink)?.grants ?? [];
    const grants = this.#uniqueNames(sink, info.grants);
    this.#connections.set(sink, { ...info, grants, sink });
    this.#byClient.set(info.clientId, sink);
    // Rebuild this connection's grant index from the announcement: the list
    // is complete, so an id it no longer names has been withdrawn.
    for (const [id, owner] of this.#byGrant) {
      if (owner === sink) this.#byGrant.delete(id);
    }
    for (const grant of grants) this.#byGrant.set(grant.id, sink);
    this.#announceChanged(before, grants);
    return previous === sink ? undefined : previous;
  }

  /**
   * The announcement with names unique among the live grants of each session.
   *
   * A name is how the model addresses a folder (`/lend/proj`), so two folders
   * answering to one name would make the second unreachable — and the lent
   * computers cannot see each other to avoid it. The server can, so it does: a
   * name already in use by another connection's grant of the same session
   * takes the lowest free suffix, exactly as one app names two folders of its
   * own (`shareNameFrom`). The FIRST announcement of a name keeps it, and a
   * re-announcement keeps it too (the name is not taken by anybody else), so
   * a reconnected app does not move a folder the conversation already knows.
   */
  #uniqueNames(sink: ShareSink, grants: readonly FolderGrant[]): FolderGrant[] {
    const taken = new Map<string, string[]>();
    const namesOf = (sessionId: string): string[] => {
      const names = taken.get(sessionId);
      if (names !== undefined) return names;
      const fresh: string[] = [];
      taken.set(sessionId, fresh);
      return fresh;
    };
    for (const [other, state] of this.#connections) {
      if (other === sink) continue;
      for (const grant of state.grants) {
        namesOf(grant.sessionId).push(grant.name);
      }
    }
    const named: FolderGrant[] = [];
    for (const grant of grants) {
      const used = namesOf(grant.sessionId);
      const name =
        !used.includes(grant.name) && isShareName(grant.name)
          ? grant.name
          : shareNameFrom(grant.path, used);
      used.push(name);
      named.push(name === grant.name ? grant : { ...grant, name });
    }
    return named;
  }

  /** The app closed its socket: its loans end now, and calls in flight fail
   * with a reason the model can act on. */
  disconnect(sink: ShareSink): void {
    const state = this.#connections.get(sink);
    if (state === undefined) return;
    this.#connections.delete(sink);
    if (this.#byClient.get(state.clientId) === sink) {
      this.#byClient.delete(state.clientId);
    }
    for (const [id, owner] of this.#byGrant) {
      if (owner === sink) this.#byGrant.delete(id);
    }
    for (const [id, pending] of this.#pending) {
      if (pending.sink !== sink) continue;
      pending.detach?.();
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(
        new Error(
          "The desktop app that lent the folder is no longer connected",
        ),
      );
    }
    this.#announceChanged(state.grants, []);
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

  /** The folders lent to one session, as the namespace and the model see
   * them: expired grants are already gone (an app that did not announce its
   * expiry must not keep a folder open). */
  grantsFor(sessionId: string): FolderGrant[] {
    const now = Date.now();
    const grants: FolderGrant[] = [];
    for (const state of this.#connections.values()) {
      for (const grant of state.grants) {
        if (grant.sessionId === sessionId && grant.expiresAt > now) {
          grants.push(grant);
        }
      }
    }
    return grants.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  /** The client's copy of the same list: what is lent, without the session
   * the server keys it by (the client already knows which conversation it
   * is looking at). */
  sharesFor(sessionId: string): FolderShare[] {
    return this.grantsFor(sessionId).map(
      ({ sessionId: _session, ...share }) => share,
    );
  }

  /** Every lending computer, for the UI to name the one that lent a folder. */
  connections(): ShareConnectionInfo[] {
    return [...this.#connections.values()].map(
      ({ clientId, host, grants }) => ({ clientId, host, grants }),
    );
  }

  /** Subscribe to changes: the sessions whose lent folders changed (gained or
   * lost). The core turns that into a client event per session. */
  onSharesChange(
    listener: (sessionIds: readonly string[]) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async call<K extends ShareOpName>(
    grantId: string,
    op: K,
    request: ShareOpMap[K]["req"],
    signal?: AbortSignal,
  ): Promise<ShareOpMap[K]["res"]> {
    const sink = this.#byGrant.get(grantId);
    if (sink === undefined) {
      throw new Error(
        "That folder is no longer lent: ask the user to lend it again",
      );
    }
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
        sink.send({ type: "cancel", id });
        reject(new Error("The operation was stopped"));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        sink.send({ type: "cancel", id });
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
        sink,
        resolve,
        reject,
        timer,
        detach: () => signal?.removeEventListener("abort", onAbort),
      });
    });
    try {
      sink.send({ type: "op", id, grant: grantId, call });
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
    return (await promise) as ShareOpMap[K]["res"];
  }

  /** Settle everything and forget every connection (the server is closing). */
  close(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.detach?.();
      this.#pending.delete(id);
      pending.reject(new Error("The server is shutting down"));
    }
    for (const sink of [...this.#connections.keys()]) this.disconnect(sink);
  }

  /** Tell the listeners which sessions changed when one app's loans did. */
  #announceChanged(
    before: readonly FolderGrant[],
    after: readonly FolderGrant[],
  ): void {
    if (this.#listeners.size === 0) return;
    const sessions = new Set<string>();
    const beforeIds = new Set(before.map((grant) => grant.id));
    const afterIds = new Set(after.map((grant) => grant.id));
    for (const grant of before) {
      if (!afterIds.has(grant.id)) sessions.add(grant.sessionId);
    }
    for (const grant of after) {
      if (!beforeIds.has(grant.id)) sessions.add(grant.sessionId);
    }
    // A loan re-lent with different terms is a change the agent must hear
    // about too (write access taken away, the shell closed).
    for (const grant of after) {
      const old = before.find((candidate) => candidate.id === grant.id);
      if (old === undefined) continue;
      if (
        old.write !== grant.write ||
        old.name !== grant.name ||
        old.expiresAt !== grant.expiresAt
      ) {
        sessions.add(grant.sessionId);
      }
    }
    if (sessions.size === 0) return;
    for (const listener of this.#listeners) listener([...sessions]);
  }
}
