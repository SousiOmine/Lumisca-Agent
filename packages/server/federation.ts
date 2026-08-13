import type { ClientEvent, ConnectionEntry } from "@lumisca/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, LOOPBACK_HOSTS } from "./routes/util.ts";

/** Error thrown when a peer cannot be reached or answers with an error;
 * carries the HTTP status to return to the UI. */
export class PeerError extends AppError {}

/** Event-stream reconnect backoff: 2s → 4s → 8s … capped at 30s. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One peer's WebSocket event stream with its own reconnect backoff.
 * Extracted from the client so one peer's failures never delay another
 * peer's reconnect (a single shared timer used to couple them).
 */
class PeerEventStream {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly peer: ConnectionEntry,
    private readonly relay: (peerId: string, event: ClientEvent) => void,
    private readonly isClosed: () => boolean,
  ) {}

  /** Open the stream (no-op when already connected or the client closed). */
  connect(): void {
    if (this.isClosed() || this.ws !== null) return;
    // The registry stores http:// URLs; the event stream speaks ws(s)://.
    const wsUrl = `${
      this.peer.url.replace(/^http/, "ws").replace(/\/+$/, "")
    }/ws?token=${encodeURIComponent(this.peer.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
    };
    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(String(evt.data)) as ClientEvent;
        this.relay(this.peer.id, event);
      } catch {
        // ignore malformed messages
      }
    };
    ws.onclose = () => {
      this.ws = null;
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

  /** Drop the connection and cancel pending reconnects. */
  close(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.isClosed() || this.timer !== null) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.attempts,
      RECONNECT_MAX_MS,
    );
    this.attempts++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
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
  private closed = false;

  constructor(
    private readonly getPeers: () => ConnectionEntry[],
    /** The hub's own origin (http://host:port), read lazily — the real
     * port is only known after the listener binds. */
    private readonly getSelfOrigin: () => string,
  ) {}

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
      if (selfUrl === null) return true;
      let url: URL;
      try {
        url = new URL(peer.url);
      } catch {
        return true;
      }
      if (url.origin === selfUrl.origin) return false;
      // The hub bound to a loopback address is reachable under several
      // spellings (localhost vs 127.0.0.1): same loopback host + same
      // port means the hub itself.
      if (
        url.port === selfUrl.port &&
        LOOPBACK_HOSTS.has(url.hostname)
      ) {
        return false;
      }
      return true;
    });
  }

  find(id: string): ConnectionEntry | undefined {
    return this.peers().find((peer) => peer.id === id);
  }

  /** Proxy a request to a peer (token header attached, 10s timeout).
   * `rawBody` (when given) is sent verbatim; otherwise `body` is
   * JSON-serialized. Throws PeerError: 502 when unreachable, or the
   * peer's own status with its error message. */
  async request(
    peer: ConnectionEntry,
    method: string,
    path: string,
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
        signal: AbortSignal.timeout(10_000),
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
      let stream = this.streams.get(peer.id);
      if (stream === undefined) {
        stream = new PeerEventStream(
          peer,
          (peerId, event) => this.relay(peerId, event),
          () => this.closed,
        );
        this.streams.set(peer.id, stream);
      }
      stream.connect();
    }
  }

  /** Drop all peer connections and reconnect to the current registry. */
  restart(): void {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
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
