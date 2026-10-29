import { upgradeWebSocket } from "hono/deno";

/**
 * The stella machine's screen relay.
 *
 * The browser cannot reach the container's VNC port: it is published on the
 * host's loopback for this server, and noVNC speaks raw RFB over a WebSocket
 * that only the container's websockify understands. This route bridges the
 * two — one WebSocket in from the page, one out to websockify — so the
 * picture travels through the same guards (Host, token, Origin) as every
 * other request instead of through a port the page is trusted to reach.
 *
 * Messages are forwarded as opaque bytes in both directions. VNC negotiates
 * its own encoding; touching the frames here would mean re-implementing RFB.
 */

/** How long a page's messages are held while the container side comes up.
 * noVNC sends its handshake immediately, before the relay has connected. */
const MAX_QUEUED_MESSAGES = 64;

export interface StellaScreenOptions {
  /** The machine's VNC port, or null when it is not running. Read at connect
   * time: the container publishes on a port chosen when it was created. */
  vncPort: () => Promise<number | null>;
}

/** One relayed connection's state. */
interface ScreenSocketData {
  port: number;
  upstream: WebSocket | null;
  /** Messages from the page that arrived before the container side was up.
   * Dropped if the upstream never connects. */
  queue: (string | Uint8Array)[];
  closed: boolean;
}

/** The stella screen's WebSocket handler, mounted at
 * `GET /api/stella/screen`. */
export function stellaScreenRoute(options: StellaScreenOptions) {
  return upgradeWebSocket(() => {
    let data: ScreenSocketData | undefined;
    return {
      async onOpen(_event, ws) {
        const port = await options.vncPort();
        if (port === null) {
          ws.close(1013, "the machine is not running");
          return;
        }
        data = { port, upstream: null, queue: [], closed: false };
        const upstream = new WebSocket(`ws://127.0.0.1:${port}/websockify`);
        upstream.binaryType = "arraybuffer";
        const current = data;
        upstream.onopen = () => {
          if (current.closed) {
            upstream.close();
            return;
          }
          current.upstream = upstream;
          for (const item of current.queue) upstream.send(item);
          current.queue.length = 0;
        };
        upstream.onmessage = (event: MessageEvent) => {
          if (current.closed) return;
          ws.send(
            typeof event.data === "string"
              ? event.data
              : new Uint8Array(event.data as ArrayBuffer),
          );
        };
        // The container side closing means the machine stopped: close the
        // page's socket too rather than leave a frozen picture that looks
        // alive.
        upstream.onclose = () => {
          if (!current.closed) ws.close();
        };
        upstream.onerror = () => {
          if (!current.closed) ws.close();
        };
      },
      onMessage(event, ws) {
        if (data === undefined) return;
        const payload = typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer);
        const upstream = data.upstream;
        if (upstream === null) {
          // Hold the handshake until the container side is up; drop the
          // oldest when a broken machine never answers.
          if (data.queue.length >= MAX_QUEUED_MESSAGES) data.queue.shift();
          data.queue.push(payload);
          return;
        }
        try {
          upstream.send(payload);
        } catch {
          ws.close();
        }
      },
      onClose() {
        if (data === undefined) return;
        data.closed = true;
        try {
          data.upstream?.close();
        } catch {
          // Already closed.
        }
        data = undefined;
      },
    };
  });
}
