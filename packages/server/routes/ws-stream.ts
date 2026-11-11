/**
 * The shape every event socket of this server has, in one place.
 *
 * Two streams carry the app's events: `/ws` (every session of this server
 * plus the relayed events of federated peers) and
 * `/stella/conversations/:agentId/events` (one stella conversation, projected
 * to what that screen draws). They differ in what they let through — that is
 * each route's business — but the machinery around it is identical, and the
 * two copies had already started to drift:
 *
 * - text deltas are batched per channel into one frame per display interval
 *   (`core/shared/ws-batch.ts`); every other frame is written after the
 *   batch is flushed, because the order is what tells the client which
 *   message a tool result belongs to. A stream that has no streaming text
 *   supplies no channel and builds no batcher at all (a stella conversation:
 *   its messages arrive when a turn ends, not as they are typed),
 * - a heartbeat proves an idle socket is alive (silence cannot be told apart
 *   from a socket a NAT or a sleeping page dropped),
 * - `onClose` settles all three (the interval, the batch, the subscription)
 *   in that order, and a send after the socket closed is swallowed.
 *
 * A route supplies only the differences: which events it accepts, how they
 * project into frames, and — when it has any — how a flushed batch is
 * shaped.
 */
import type { ClientEvent } from "@lumisca/core";
import {
  createFrameBatcher,
  type DeltaFrame,
  type FrameBatcher,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TYPE,
} from "@lumisca/core/shared";

/** The text a batched event appends: the reply's words, or a card being
 * written. */
function deltaText(event: ClientEvent): string {
  return event.type === "message_delta" || event.type === "card_delta"
    ? event.delta
    : "";
}

/** The minimal socket surface the stream writes to (Hono's WSContext). */
interface Socket {
  send(data: string): void;
  close?(code: number, reason: string): void;
}

/** What a route may write with. `write` bypasses the batch; `send` flushes it
 * first — use `send` for anything that follows the stream's order (a frame a
 * client may see beside the streaming text). */
export interface SocketWriter {
  write(payload: unknown): void;
  send(payload: unknown): void;
}

export interface EventStreamOptions {
  /** Register the core subscription; returns a detach. */
  subscribe: (listener: (event: ClientEvent) => void) => () => void;
  /** Whether this socket carries the event at all. */
  accept: (event: ClientEvent) => boolean;
  /** The revision an event's session is at (the client's gap detector), or
   * undefined for an event that belongs to no session. */
  revOf: (event: ClientEvent) => number | undefined;
  /** Frames to write for one event, after the batch was flushed. An event
   * that carries streaming text never reaches this on a stream with a
   * `delta` channel (it is batched); a stream without one projects every
   * event. */
  project: (
    event: ClientEvent,
    rev: number | undefined,
  ) => Record<string, unknown>[];
  /** The batch channel of a streaming delta. Omitted → this stream has no
   * batched deltas, so no batcher is built and every event goes through
   * `project`. */
  delta?: {
    /** Which delta events this stream batches. Omitted → `message_delta`
     * only (the reply being typed). A stella conversation batches
     * `card_delta` instead: it has no streaming text, but a card is drawn
     * while the model writes it. */
    accepts?: (event: ClientEvent) => boolean;
    /** The batch channel: which transcript (or call) the text belongs to. */
    key: (event: ClientEvent) => string;
    /** How one flushed batch reaches the wire. */
    frame: (batch: DeltaFrame<string, number>) => unknown;
  };
  /** Extra subscriptions written through the same writer (the federation
   * relay on `/ws`); returns a detach. */
  relay?: (writer: SocketWriter) => () => void;
  /** Batch interval; omitted → the batcher's default (one display frame).
   * Meaningless without `delta`. */
  flushMs?: number;
  /** Heartbeat cadence; omitted → the shared constant. */
  heartbeatMs?: number;
}

/** The handlers `upgradeWebSocket` expects, for one connection. */
export interface EventStreamHandlers {
  onOpen(_event: unknown, ws: Socket): void;
  onClose(): void;
}

/** Build one socket's handlers (call once per connection). */
export function createEventStream(
  options: EventStreamOptions,
): EventStreamHandlers {
  let detach: (() => void) | undefined;
  let detachRelay: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let batcher: FrameBatcher<string, number> | undefined;
  let socket: Socket | undefined;

  const batches = (event: ClientEvent): boolean =>
    options.delta?.accepts === undefined
      ? event.type === "message_delta"
      : options.delta.accepts(event);

  const write = (payload: unknown): void => {
    // The socket can close between the event and the send (the detach below
    // runs on close, but a concurrent event can race it); a throw here would
    // kill the subscribe handler for every later event too.
    try {
      socket?.send(JSON.stringify(payload));
    } catch {
      // connection is gone; nothing to do
    }
  };
  const writer: SocketWriter = {
    write,
    send: (payload) => {
      batcher?.flush();
      write(payload);
    },
  };

  return {
    onOpen(_event, ws) {
      socket = ws;
      const delta = options.delta;
      batcher =
        delta === undefined
          ? undefined
          : createFrameBatcher<string, number>({
              ...(options.flushMs === undefined
                ? {}
                : { flushMs: options.flushMs }),
              flush: (batch) => write(delta.frame(batch)),
            });
      detach = options.subscribe((event) => {
        if (!options.accept(event)) return;
        const rev = options.revOf(event);
        if (batcher !== undefined && delta !== undefined && batches(event)) {
          // Only a stream with a channel batches text; `project` decides
          // what a delta is worth to the others (stella's projection drops a
          // reply's text — it arrives whole when its turn ends).
          if (rev === undefined) return;
          batcher.delta(delta.key(event), deltaText(event), rev);
          return;
        }
        for (const frame of options.project(event, rev)) {
          writer.send(frame);
        }
      });
      detachRelay = options.relay?.(writer);
      heartbeat = setInterval(
        () => writer.send({ type: WS_HEARTBEAT_TYPE }),
        options.heartbeatMs ?? WS_HEARTBEAT_INTERVAL_MS,
      );
    },
    onClose() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      // Text the model already produced is flushed before the socket is
      // gone (the client may be closing its side, but the batch is this
      // side's buffer).
      batcher?.close();
      batcher = undefined;
      detach?.();
      detachRelay?.();
      detach = undefined;
      detachRelay = undefined;
      socket = undefined;
    },
  };
}
