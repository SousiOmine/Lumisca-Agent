import { createReconnectScheduler } from "../reconnect.ts";

/** The callbacks one connection reports to. */
export interface StreamHandlers<E> {
  onEvent(event: E): void;
  /** The socket closed without the controller closing it. */
  onClose(): void;
  /** The socket opened (every connection, including a reconnect). */
  onOpen(): void;
}

/** One event stream's connection lifecycle: connect, reconnect with backoff,
 * and a teardown that cannot resurrect it. */
export interface StreamController {
  /** Open now, cancelling a pending retry. */
  connect(): void;
  /** Close the socket and cancel any retry (the caller is leaving). */
  close(): void;
}

/**
 * The part both event streams share: one socket at a time, a retry with the
 * common backoff after a drop, and a close that drops a retry a callback had
 * already scheduled.
 *
 * What a stream does with a frame (a session's deltas and snapshots, a
 * conversation's entries) stays in the hook that owns its state; this only
 * ensures the transport cannot be opened twice or outlive its owner.
 */
export function createStreamController<E>(
  options: {
    /** Open one socket and return its closer. */
    connect(handlers: StreamHandlers<E>): () => void;
    onEvent(event: E): void;
    onClose(): void;
    onOpen(): void;
    /** Whether the owner has gone away; a retry then never runs. */
    stopped(): boolean;
  },
): StreamController {
  let close: (() => void) | undefined;
  let disposed = false;
  const reconnect = createReconnectScheduler({
    stopped: () => disposed || options.stopped(),
  });

  const teardown = () => {
    reconnect.cancel();
    close?.();
    close = undefined;
  };

  const connect = () => {
    teardown();
    if (disposed || options.stopped()) return;
    close = options.connect({
      onEvent(event) {
        if (!disposed) options.onEvent(event);
      },
      onClose() {
        if (disposed) return;
        // The socket is gone; its closer would be a no-op. Clearing it keeps
        // a later teardown from calling into a dead stream.
        close = undefined;
        options.onClose();
        reconnect.schedule(connect);
      },
      onOpen() {
        if (disposed) return;
        reconnect.reset();
        options.onOpen();
      },
    });
  };

  return {
    connect,
    close() {
      disposed = true;
      teardown();
    },
  };
}
