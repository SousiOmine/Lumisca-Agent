import type { ClientEvent, ConnectionEntry } from "@lumisca/core";
import { createLogger } from "@lumisca/core";

/**
 * One peer's WebSocket event stream, with its own reconnect backoff.
 *
 * Split out of federation.ts, which also holds the HTTP proxy, the
 * self-identity probe and the event fan-out: a reconnect state machine is a
 * different kind of thing from a request proxy, and a change to one should
 * not require reading the other.
 *
 * The rule that matters here is the `closed` flag: a stream its owner dropped
 * must never dial in again, or the peer's events arrive twice through a
 * socket nobody holds.
 */

const log = createLogger("federation");

/** First reconnect delay (the production backoff). */
export const RECONNECT_BASE_MS = 2_000;

/** Cap of the backoff. Grows with the base so a test's short delays stay
 * short. */
export const RECONNECT_MAX_MS = 30_000;

/**
 * One peer's WebSocket event stream with its own reconnect backoff.
 * Extracted from the client so one peer's failures never delay another
 * peer's reconnect (a single shared timer used to couple them).
 */
export class PeerEventStream {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by close(): this stream is gone and must never reconnect. Kept
   * apart from the client's own `closed` flag, which stays false across a
   * restart (the client keeps relaying through a fresh set of streams) —
   * without this flag the dropped stream's `onclose` would schedule a
   * reconnect that opens a socket nobody holds a reference to: the peer's
   * events would arrive twice and the orphan could never be closed. */
  private closed = false;

  constructor(
    private readonly peer: ConnectionEntry,
    private readonly relay: (peerId: string, event: ClientEvent) => void,
    private readonly isClosed: () => boolean,
    /** Announce the stream's state to the hub's UI clients (true when the
     * relay is up, false when it dropped — see ClientEvent's peer_stream). */
    private readonly onState: (connected: boolean) => void,
    /** First reconnect delay (defaults to the production backoff). A test
     * observes "the dropped stream never dials in again" by waiting past
     * this, and it must not have to wait 2 seconds to say so. */
    private readonly baseDelayMs: number = RECONNECT_BASE_MS,
  ) {}

  /** Open the stream (no-op when already connected, dropped, or the client
   * closed). */
  connect(): void {
    if (this.closed || this.isClosed() || this.ws !== null) return;
    // The registry stores http:// URLs; the event stream speaks ws(s)://.
    const wsUrl = `${
      this.peer.url.replace(/^http/, "ws").replace(/\/+$/, "")
    }/ws?token=${encodeURIComponent(this.peer.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      log.debug(`peer ${this.peer.id}: connect failed, reconnecting`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      // The relay is up: a client that was watching this peer's sessions
      // through a gap re-reads their snapshots (see peer_stream).
      this.onState(true);
    };
    ws.onmessage = (evt) => {
      let frame: ClientEvent;
      try {
        frame = JSON.parse(String(evt.data)) as ClientEvent;
      } catch {
        return; // malformed message
      }
      // A frame that still carries a peer id was relayed by the peer's own
      // hub: it did not originate there. This hub receives each configured
      // peer's events directly, so relaying it again would only send the
      // same event twice — and it never ends. The hub's /ws stamps every
      // frame it sends (its own events with "", a peer's with that peer's
      // id), so the relayed copy comes back here as an input, this method
      // relays it again, and a hub registered under a spelling the URL
      // self-check does not know (its tailnet name, a reverse proxy) talks
      // to itself in a tight loop. That loop pins a core, floods every UI
      // client, and — with one large frame in flight — exhausts the process
      // memory, which is how the server used to die under the OOM killer.
      const source = (frame as { peerId?: unknown }).peerId;
      if (typeof source === "string" && source !== "") return;
      this.relay(this.peer.id, frame);
    };
    ws.onclose = () => {
      this.ws = null;
      log.debug(`peer ${this.peer.id}: stream closed, reconnecting`);
      // Events are lost until the reconnect: tell the UI so its views of
      // this peer's sessions can be re-read instead of silently stale.
      this.onState(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; closing here triggers the reconnect path early.
      try {
        ws.close();
      } catch {
        // already closed
      }
    };
  }

  /** Drop the connection, cancel pending reconnects, and retire the stream:
   * a closed stream never connects again (see the `closed` field). */
  close(): void {
    // Before the socket is closed, so the `onclose` this triggers cannot
    // schedule a reconnect for a stream its owner has already dropped.
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.isClosed() || this.timer !== null) return;
    const delay = Math.min(
      this.baseDelayMs * 2 ** this.attempts,
      // The cap scales with the base so a test's short delays stay short.
      Math.max(RECONNECT_MAX_MS, this.baseDelayMs * 16),
    );
    this.attempts++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
