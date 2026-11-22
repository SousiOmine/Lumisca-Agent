/**
 * The folders the lending apps say they lend, and the index the file
 * operations read.
 *
 * The truth about a loan is the lending app's: it decides, expires and
 * withdraws, and every one of those arrives here as an announcement. That is
 * why nothing is stored — a folder is lent for minutes, and a row that
 * outlived the app would promise an agent a folder nobody is serving. A
 * disconnect is therefore not a failure to report but the end of the loan,
 * which is the same thing the user sees when they quit the app.
 *
 * This class owns what is LENT and who to ask for it. The calls into those
 * folders are the broker's (see call-broker.ts) and the names the model
 * addresses them by are the namespace's (see namespace.ts); the hub above
 * them is the one object the rest of the app talks to.
 */

import type { FolderShare, ShareHostInfo } from "../domain/share.ts";
import { type FolderGrant, isExpired } from "./grant.ts";
import { ShareNamespace } from "./namespace.ts";
import type { ShareServerFrame } from "./ops.ts";

/** Where the hub writes to reach one lending app. The server's route owns the
 * socket; the registry only hands it frames. */
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

/** One live connection: what the app said, and where to reach it. */
export interface ShareConnection extends ShareConnectionInfo {
  sink: ShareSink;
}

export class ShareRegistry {
  readonly #connections = new Map<ShareSink, ShareConnection>();
  /** The app run (clientId) to its live connection: a reconnecting app
   * replaces its own entry instead of appearing as a second computer. */
  readonly #byClient = new Map<string, ShareSink>();
  /** Grant id to the connection that owns it: one lookup per file operation. */
  readonly #byGrant = new Map<string, ShareSink>();
  readonly #listeners = new Set<(sessionIds: readonly string[]) => void>();
  readonly #namespace = new ShareNamespace();

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
      this.disconnectSink(previous);
    }
    const before = this.#connections.get(sink)?.grants ?? [];
    const grants = this.#namespace.unique(sink, info.grants, this.#connections);
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

  /** The app closed its socket: its loans end now. The calls in flight are
   * the broker's to fail, so it is told before the grants go. */
  disconnectSink(sink: ShareSink): ShareConnection | undefined {
    const state = this.#connections.get(sink);
    if (state === undefined) return undefined;
    this.#connections.delete(sink);
    if (this.#byClient.get(state.clientId) === sink) {
      this.#byClient.delete(state.clientId);
    }
    for (const [id, owner] of this.#byGrant) {
      if (owner === sink) this.#byGrant.delete(id);
    }
    this.#announceChanged(state.grants, []);
    return state;
  }

  /** The sink that may answer for one grant, or undefined when the loan is
   * gone (the app disconnected, or re-announced without it). */
  sinkOf(grantId: string): ShareSink | undefined {
    return this.#byGrant.get(grantId);
  }

  /** The live connection behind one grant, for the broker's bookkeeping. */
  connectionOf(grantId: string): ShareConnection | undefined {
    const sink = this.#byGrant.get(grantId);
    return sink === undefined ? undefined : this.#connections.get(sink);
  }

  /** The folders lent to one session, as the namespace and the model see
   * them: expired grants are already gone (an app that did not announce its
   * expiry must not keep a folder open). */
  grantsFor(sessionId: string, now: number): FolderGrant[] {
    const grants: FolderGrant[] = [];
    for (const state of this.#connections.values()) {
      for (const grant of state.grants) {
        if (grant.sessionId === sessionId && !isExpired(grant, now)) {
          grants.push(grant);
        }
      }
    }
    return grants.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  /** Every lending computer, for the UI to name the one that lent a folder. */
  connections(): ShareConnectionInfo[] {
    return [...this.#connections.values()].map(
      ({ clientId, host, grants }) => ({ clientId, host, grants }),
    );
  }

  /** The live connections, for a close that has to end every one of them. */
  connectionSinks(): ShareSink[] {
    return [...this.#connections.keys()];
  }

  /** Subscribe to changes: the sessions whose lent folders changed (gained or
   * lost). The core turns that into a client event per session. */
  onSharesChange(
    listener: (sessionIds: readonly string[]) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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

/** The client's copy of a session's list: what is lent, without the session
 * the server keys it by (the client already knows which conversation it is
 * looking at). */
export function sharesOf(grants: readonly FolderGrant[]): FolderShare[] {
  return grants.map(({ sessionId: _session, ...share }) => share);
}
