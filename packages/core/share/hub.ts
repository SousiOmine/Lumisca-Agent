/**
 * The server's view of the computers that lend folders, kept in memory only.
 *
 * Three things answer three questions, and this class is the one object the
 * rest of the app talks to:
 *
 * - {@link ShareRegistry} — what is lent, by whom, and until when;
 * - {@link ShareNamespace} — what each loan is called in the agent's
 *   namespace (used by the registry when an announcement is recorded);
 * - {@link ShareCallBroker} — one call into a lent folder and its answer,
 *   with the timeout, the abort and the disconnect settled in one place.
 *
 * Splitting them is what keeps "which folders may this session reach" a
 * question about state and "did the file operation answer" a question about a
 * promise: changing one used to mean reading both. This class owns only the
 * composition — which sink answers a grant, and what happens to the calls in
 * flight when that sink goes away — so the transport interface the backends
 * take is still satisfied by one object.
 */
import type { FolderShare, ShareHostInfo } from "../domain/share.ts";
import { ShareCallBroker } from "./call-broker.ts";
import { type FolderGrant, isExpired } from "./grant.ts";
import type {
  ShareOpMap,
  ShareOpName,
  ShareResult,
  ShareTransport,
} from "./ops.ts";
import {
  type ShareConnectionInfo,
  ShareRegistry,
  type ShareSink,
  sharesOf,
} from "./registry.ts";

export type { ShareConnectionInfo, ShareSink } from "./registry.ts";

export class ShareHub implements ShareTransport {
  readonly #registry = new ShareRegistry();
  readonly #broker: ShareCallBroker;

  constructor(options: { opTimeoutMs?: number; execGraceMs?: number } = {}) {
    this.#broker = new ShareCallBroker(options);
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
    const previous = this.#registry.register(sink, info);
    // A reconnect replaces its own app run: the work the old socket owed is
    // not the new socket's to answer, so it fails now rather than at the
    // timeout. (The registry has already dropped the old loans, which is why
    // this runs after it.)
    if (previous !== undefined) {
      this.#broker.failCallsOf(
        previous,
        "The desktop app that lent the folder is no longer connected",
      );
    }
    return previous;
  }

  /** The app closed its socket: its loans end now, and calls in flight fail
   * with a reason the model can act on. */
  disconnect(sink: ShareSink): void {
    this.#registry.disconnectSink(sink);
    this.#broker.failCallsOf(
      sink,
      "The desktop app that lent the folder is no longer connected",
    );
  }

  /** One answer from a lending app. */
  settle(
    sink: ShareSink,
    frame:
      | { type: "result"; id: string; ok: true; value: unknown }
      | { type: "result"; id: string; ok: false; error: string },
  ): void {
    this.#broker.settle(sink, frame);
  }

  /** The folders lent to one session, as the namespace and the model see
   * them: expired grants are already gone. */
  grantsFor(sessionId: string): FolderGrant[] {
    return this.#registry.grantsFor(sessionId, Date.now());
  }

  /** Whether one grant is still lent (the file backend's own check: a call
   * that starts after the deadline must not reach the app). */
  isLive(grant: FolderGrant): boolean {
    return (
      !isExpired(grant, Date.now()) &&
      this.#registry.sinkOf(grant.id) !== undefined
    );
  }

  /** The client's copy of the same list: what is lent, without the session
   * the server keys it by (the client already knows which conversation it
   * is looking at). */
  sharesFor(sessionId: string): FolderShare[] {
    return sharesOf(this.grantsFor(sessionId));
  }

  /** Every lending computer, for the UI to name the one that lent a folder. */
  connections(): Array<{
    clientId: string;
    host: ShareHostInfo;
    grants: FolderGrant[];
  }> {
    return this.#registry.connections();
  }

  /** Subscribe to changes: the sessions whose lent folders changed (gained or
   * lost). The core turns that into a client event per session. */
  onSharesChange(
    listener: (sessionIds: readonly string[]) => void,
  ): () => void {
    return this.#registry.onSharesChange(listener);
  }

  async call<K extends ShareOpName>(
    grantId: string,
    op: K,
    request: ShareOpMap[K]["req"],
    signal?: AbortSignal,
  ): Promise<ShareResult<K>> {
    // The one place a grant id is turned into a connection: a grant nobody
    // owns anymore is refused before a frame is built or an id is spent.
    const owner = this.#registry.sinkOf(grantId);
    if (owner === undefined) {
      throw new Error(
        "That folder is no longer lent: ask the user to lend it again",
      );
    }
    return await this.#broker.call(owner, op, request, grantId, signal);
  }

  /** Settle everything and forget every connection (the server is closing). */
  close(): void {
    this.#broker.close("The server is shutting down");
    for (const sink of this.#registry.connectionSinks()) {
      this.#registry.disconnectSink(sink);
    }
  }
}
