import type { ClientEvent, ConnectionEntry } from "@lumisca/core";
import { createLogger } from "@lumisca/core";
import { isLoopbackHost } from "@lumisca/core/shared";
import type { ContentfulStatusCode } from "hono/http-status";
import { AppError } from "./routes/util.ts";

/** Error thrown when a peer cannot be reached or answers with an error;
 * carries the HTTP status to return to the UI. */
export class PeerError extends AppError {}

/** Debug-gated logger: reconnect storms are normal (a peer may be down),
 * but diagnosing "why is the peer red" needs the attempt trail. */
const log = createLogger("federation");

/** Event-stream reconnect backoff: 2s → 4s → 8s … capped at 30s. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/** How long the identity probe may take. It only has to recognise the hub
 * itself under another URL; a peer that does not answer within this window
 * is treated as remote, which is what its own reconnect backoff assumes
 * anyway. */
const IDENTITY_PROBE_MS = 3000;

/** Budget of one proxied request. A peer on a tailnet answers a reads in
 * well under a second, so this is generous for the ordinary call — and it
 * used to be the ONLY budget, which is what made the long ones fail: opening
 * a session on a cold machine (an agent restored from disk, a VM image being
 * checked), a transcript snapshot of a compacted conversation and an on-
 * demand compaction all legitimately take longer, and a proxy that gives up
 * at ten seconds turns a slow answer into an error the peer never made. */
const PROXY_TIMEOUT_MS = 30_000;

/** Budget of the paths that are legitimately slow (see above). Chosen to sit
 * under the desktop's own limits while comfortably above the work. */
const PROXY_SLOW_TIMEOUT_MS = 120_000;

/** Paths whose handlers do real work rather than read a row: opening a
 * session (which may restore an agent), reading a transcript window, and the
 * two explicit compactions. Matched by suffix because the peer's routes are
 * mounted under `/api` and the proxy forwards the remainder verbatim. */
const SLOW_PATH_PATTERNS = [
  /^\/api\/sessions\/[^/]+\/messages(\?|$)/,
  /^\/api\/sessions\/[^/]+\/open$/,
  /^\/api\/sessions\/[^/]+\/compact$/,
  /^\/api\/sessions\/[^/]+\/rewind$/,
  /^\/api\/stella\/conversations\/[^/]+\/messages(\?|$)/,
  /^\/api\/stella\/session(\?|$)/,
  /^\/api\/stella\/conversations\/[^/]+\/compact$/,
];

/** The budget one proxied path gets (see {@link PROXY_TIMEOUT_MS}). */
export function proxyTimeoutFor(path: string): number {
  return SLOW_PATH_PATTERNS.some((pattern) => pattern.test(path))
    ? PROXY_SLOW_TIMEOUT_MS
    : PROXY_TIMEOUT_MS;
}

/** Registry key of a peer for the identity probe. The id alone would keep an
 * entry the user re-pointed at another machine excluded forever, and the URL
 * alone would mix two entries that name the same address. */
function peerKey(peer: ConnectionEntry): string {
  return `${peer.id}\u0000${peer.url}`;
}

/**
 * One peer's WebSocket event stream with its own reconnect backoff.
 * Extracted from the client so one peer's failures never delay another
 * peer's reconnect (a single shared timer used to couple them).
 */
class PeerEventStream {
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

/** First reconnect delay and self-identification for one client. */
export interface FederationClientOptions {
  /** First reconnect delay for every peer stream (tests shorten it; the
   * production value is the 2s backoff). */
  reconnectBaseMs?: number;
  /** This server's own instance id — the value its `/api/health` reports.
   * A peer that answers the probe with it is this hub itself under another
   * spelling (see identityOf). Omitted → the URL check is the only
   * self-guard, which is what a hand-built client (a test) wants. */
  selfId?: () => string;
}

/**
 * Hub-side client for the federated peers (the server-side connection
 * registry). Proxies HTTP requests to each peer and relays the peer's
 * WebSocket event streams to the hub's UI clients, tagged with the peer id
 * so the UI can route events to the right session tabs.
 */
export class FederationClient {
  private readonly streams = new Map<string, PeerEventStream>();
  private readonly listeners = new Set<
    (peerId: string, event: ClientEvent) => void
  >();
  /** Peer entries a probe found to be this hub itself, keyed by peerKey. */
  private readonly selfPeers = new Set<string>();
  /** Identity probes by peerKey: resolved verdicts are not asked again, and
   * concurrent callers share the request in flight. */
  private readonly identities = new Map<string, Promise<boolean>>();
  private readonly reconnectBaseMs: number;
  private readonly getSelfId: () => string;
  private closed = false;

  constructor(
    private readonly getPeers: () => ConnectionEntry[],
    /** The hub's own origin (http://host:port), read lazily — the real
     * port is only known after the listener binds. */
    private readonly getSelfOrigin: () => string,
    options: FederationClientOptions = {},
  ) {
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.getSelfId = options.selfId ?? (() => "");
  }

  /** Peers from the registry, excluding the hub itself. */
  peers(): ConnectionEntry[] {
    const self = this.getSelfOrigin();
    let selfUrl: URL | null = null;
    if (self !== "") {
      try {
        selfUrl = new URL(self);
      } catch {
        selfUrl = null;
      }
    }
    return this.getPeers().filter((peer) => {
      // A probe answered with our own instance id: the same running server
      // under another name (its tailnet name, a proxy, a LAN address). The
      // URL check below cannot see that from the text alone.
      if (this.selfPeers.has(peerKey(peer))) return false;
      if (selfUrl === null) return true;
      let url: URL;
      try {
        url = new URL(peer.url);
      } catch {
        return true;
      }
      if (url.origin === selfUrl.origin) return false;
      // The hub bound to a loopback address is reachable under several
      // spellings (localhost vs 127.0.0.1 vs [::1]): same loopback host +
      // same port means the hub itself.
      if (
        url.port === selfUrl.port &&
        isLoopbackHost(url.hostname)
      ) {
        return false;
      }
      return true;
    });
  }

  find(id: string): ConnectionEntry | undefined {
    return this.peers().find((peer) => peer.id === id);
  }

  /** Proxy a request to a peer (token header attached; the budget depends on
   * the path, see proxyTimeoutFor). `rawBody` (when given) is sent verbatim;
   * otherwise `body` is JSON-serialized. Throws PeerError: 502 when
   * unreachable (or too slow), or the peer's own status with its error
   * message. */
  async request(
    peer: ConnectionEntry,
    method: string,
    path: string,
    body?: unknown,
    rawBody?: string,
  ): Promise<Response> {
    return await this.requestWithTimeout(
      peer,
      method,
      path,
      proxyTimeoutFor(path),
      body,
      rawBody,
    );
  }

  /** {@link request} with an explicit budget (the peer probe uses a short
   * one: its answer only says whether a machine is up, and waiting a full
   * request budget per peer makes the UI's peer list as slow as its slowest
   * machine). */
  async requestWithTimeout(
    peer: ConnectionEntry,
    method: string,
    path: string,
    timeoutMs: number,
    body?: unknown,
    rawBody?: string,
  ): Promise<Response> {
    const url = `${peer.url.replace(/\/+$/, "")}${path}`;
    const hasBody = body !== undefined || rawBody !== undefined;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          "x-lumisca-token": peer.token,
        },
        body: rawBody ??
          (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PeerError(
        `ピアに接続できません: ${peer.name} (${peer.url})`,
        502,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = `ピアがエラーを返しました: ${peer.name} (${res.status})`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.length > 0) {
          message = parsed.error;
        }
      } catch {
        // non-JSON error body; keep the default message
      }
      throw new PeerError(message, res.status as ContentfulStatusCode);
    }
    return res;
  }

  /** Receive every peer's events, tagged with the peer id. */
  subscribe(
    listener: (peerId: string, event: ClientEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connect event streams to all peers (call after the registry
   * changes). */
  start(): void {
    for (const peer of this.peers()) {
      void this.open(peer);
    }
  }

  /** Open one peer's event stream once its identity is known. The probe runs
   * first so a peer that IS this hub is never opened at all: opening it
   * would already deliver our own events to the UI under its tag, and the
   * relay's rule against re-relaying peer-tagged frames (see
   * PeerEventStream) would stop the loop only after the first copy. A peer
   * that does not answer the probe is treated as remote, so a merely down
   * peer keeps its usual reconnect behavior. */
  private async open(peer: ConnectionEntry): Promise<void> {
    if (await this.identityOf(peer)) {
      log.debug(`peer ${peer.id}: this hub itself, not federating with it`);
      return;
    }
    // The registry may have changed while the probe ran: only the current
    // entry, still at the URL that was probed, may be opened (a restart
    // during the probe would otherwise leave a stream on the old URL).
    const current = this.getPeers().find((entry) => entry.id === peer.id);
    if (this.closed || current === undefined || current.url !== peer.url) {
      return;
    }
    let stream = this.streams.get(peer.id);
    if (stream === undefined) {
      stream = new PeerEventStream(
        peer,
        (peerId, event) => this.relay(peerId, event),
        () => this.closed,
        (connected) =>
          this.relay(peer.id, {
            type: "peer_stream",
            peerId: peer.id,
            connected,
          }),
        this.reconnectBaseMs,
      );
      this.streams.set(peer.id, stream);
    }
    stream.connect();
  }

  /** Whether `peer` is this hub itself, running under another spelling.
   *
   * `peers()` recognises loopback aliases from the URL text; the same server
   * is also reachable as its tailnet name, its LAN address, or through a
   * reverse proxy, and the registry entry written for switching servers
   * (which is the same list) may well name it. A hub that federates with
   * itself relays its own events back into its own `/ws` — an echo that
   * never ends.
   *
   * The probe asks the peer's `/api/health`, whose `instanceId` is a
   * per-process uuid: it answers "is this the same running server?", which
   * is exactly what the URL cannot answer. A peer that cannot be reached is
   * not this hub. */
  private identityOf(peer: ConnectionEntry): Promise<boolean> {
    const key = peerKey(peer);
    const known = this.identities.get(key);
    if (known !== undefined) return known;
    const probe = this.probeIdentity(peer).then((self) => {
      if (self) this.selfPeers.add(key);
      return self;
    }).catch(() => false);
    this.identities.set(key, probe);
    return probe;
  }

  private async probeIdentity(peer: ConnectionEntry): Promise<boolean> {
    const selfId = this.getSelfId();
    if (selfId === "") return false;
    const response = await fetch(
      `${peer.url.replace(/\/+$/, "")}/api/health`,
      {
        headers: { "x-lumisca-token": peer.token },
        signal: AbortSignal.timeout(IDENTITY_PROBE_MS),
      },
    );
    if (!response.ok) return false;
    const body = await response.json() as { instanceId?: unknown };
    return typeof body.instanceId === "string" && body.instanceId === selfId;
  }

  /** Drop all peer connections and reconnect to the current registry. */
  restart(): void {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    // The registry changed: an entry may point at another machine now, so
    // every identity is probed again.
    this.identities.clear();
    this.selfPeers.clear();
    this.start();
  }

  /** Stop all connections; no further reconnects. */
  close(): void {
    this.closed = true;
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
  }

  private relay(peerId: string, event: ClientEvent): void {
    for (const listener of this.listeners) {
      listener(peerId, event);
    }
  }
}
