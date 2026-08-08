import type { ClientEvent, ConnectionEntry } from "@lumisca/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "./routes/util.ts";

/** One peer's reachability, reported to the UI. */
export interface PeerStatus {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
}

/** Error thrown when a peer cannot be reached or answers with an error;
 * carries the HTTP status to return to the UI. */
export class PeerError extends AppError {}

/** Hostnames that always mean "this machine" for the self-guard. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Hub-side client for the federated peers (the server-side connection
 * registry). Proxies HTTP requests to each peer and relays the peer's
 * WebSocket event stream to the hub's UI clients, tagged with the peer id
 * so the UI can route events to the right session tabs.
 */
export class FederationClient {
  private readonly wsByPeer = new Map<string, WebSocket>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly listeners = new Set<
    (peerId: string, event: ClientEvent) => void
  >();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
   * Throws PeerError: 502 when unreachable, or the peer's own status with
   * its error message. */
  async request(
    peer: ConnectionEntry,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${peer.url.replace(/\/+$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "x-lumisca-token": peer.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

  /** Reachability of every peer (GET /api/health with the token). */
  async status(): Promise<PeerStatus[]> {
    const results = await Promise.all(
      this.peers().map(async (peer) => {
        try {
          await this.request(peer, "GET", "/api/health");
          return { id: peer.id, name: peer.name, ok: true };
        } catch (error) {
          return {
            id: peer.id,
            name: peer.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return results;
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
    for (const peer of this.peers()) this.connect(peer);
  }

  /** Drop all peer connections and reconnect to the current registry. */
  restart(): void {
    for (const ws of this.wsByPeer.values()) ws.close();
    this.wsByPeer.clear();
    this.reconnectAttempts.clear();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.start();
  }

  /** Stop all connections; no further reconnects. */
  close(): void {
    this.closed = true;
    for (const ws of this.wsByPeer.values()) ws.close();
    this.wsByPeer.clear();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(peer: ConnectionEntry): void {
    if (this.closed || this.wsByPeer.has(peer.id)) return;
    // The registry stores http:// URLs; the event stream speaks ws(s)://.
    const wsUrl = `${
      peer.url.replace(/^http/, "ws").replace(/\/+$/, "")
    }/ws?token=${encodeURIComponent(peer.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect(peer);
      return;
    }
    this.wsByPeer.set(peer.id, ws);
    ws.onopen = () => this.reconnectAttempts.delete(peer.id);
    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(String(evt.data)) as ClientEvent;
        for (const listener of this.listeners) {
          listener(peer.id, event);
        }
      } catch {
        // ignore malformed messages
      }
    };
    ws.onclose = () => {
      this.wsByPeer.delete(peer.id);
      this.scheduleReconnect(peer);
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

  private scheduleReconnect(peer: ConnectionEntry): void {
    if (this.closed) return;
    const attempt = this.reconnectAttempts.get(peer.id) ?? 0;
    this.reconnectAttempts.set(peer.id, attempt + 1);
    // Backoff 2s → 4s → 8s … capped at 30s; one shared timer for all peers.
    const delay = Math.min(2000 * 2 ** attempt, 30_000);
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      for (const p of this.peers()) {
        if (!this.wsByPeer.has(p.id)) this.connect(p);
      }
    }, delay);
  }
}
