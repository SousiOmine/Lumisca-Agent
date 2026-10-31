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
 *   message a tool result belongs to,
 * - a heartbeat proves an idle socket is alive (silence cannot be told apart
 *   from a socket a NAT or a sleeping page dropped),
 * - `onClose` settles all three (the interval, the batch, the subscription)
 *   in that order, and a send after the socket closed is swallowed.
 *
 * A route supplies only the differences: which events it accepts, how they
 * project into frames, and how a flushed batch is shaped.
 */
import type { ClientEvent } from "@lumisca/core";
import {
  createFrameBatcher,
  type DeltaFrame,
  type FrameBatcher,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TYPE,
} from "@lumisca/core/shared";

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
   * that carries streaming text never reaches this (it is batched). */
  project: (
    event: ClientEvent,
    rev: number | undefined,
  ) => Record<string, unknown>[];
  /** The batch channel of a streaming delta. */
  deltaKey: (event: ClientEvent) => string;
  /** How one flushed batch reaches the wire. */
  deltaFrame: (batch: DeltaFrame<string, number>) => unknown;
  /** Extra subscriptions written through the same writer (the federation
   * relay on `/ws`); returns a detach. */
  relay?: (writer: SocketWriter) => () => void;
  /** Batch interval; omitted → the batcher's default (one display frame). */
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
      batcher = createFrameBatcher<string, number>({
        ...(options.flushMs === undefined ? {} : { flushMs: options.flushMs }),
        flush: (batch) => write(options.deltaFrame(batch)),
      });
      detach = options.subscribe((event) => {
        if (!options.accept(event)) return;
        const rev = options.revOf(event);
        if (event.type === "message_delta") {
          if (rev === undefined) return;
          batcher?.delta(options.deltaKey(event), event.delta, rev);
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
