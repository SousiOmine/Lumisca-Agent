import { assertEquals } from "@std/assert";
import { WS_HEARTBEAT_TYPE } from "@lumisca/core/shared";
import { openEventStream } from "./event-stream.ts";

/**
 * A stand-in for the browser's WebSocket: it records what was opened and lets
 * the test drive open/message/close.
 */
class FakeSocket {
  static last: FakeSocket | undefined;
  readonly url: string;
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  send(): void {}
  close(): void {
    this.closed = true;
  }
}

function installFakeSocket(): () => void {
  const globals = globalThis as unknown as {
    WebSocket: unknown;
    location: unknown;
    document: unknown;
  };
  const original = {
    WebSocket: globals.WebSocket,
    location: globals.location,
    document: globals.document,
  };
  globals.WebSocket = FakeSocket;
  globals.location = { protocol: "http:", host: "127.0.0.1:8000" };
  globals.document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return () => {
    globals.WebSocket = original.WebSocket;
    globals.location = original.location;
    globals.document = original.document;
  };
}

Deno.test("openEventStream: heartbeats never reach the caller", () => {
  const restore = installFakeSocket();
  try {
    const events: unknown[] = [];
    const close = openEventStream<{ type: string }>(
      { path: "/ws" },
      (event) => events.push(event),
      () => {},
    );
    const socket = FakeSocket.last!;
    assertEquals(socket.url, "ws://127.0.0.1:8000/ws");
    socket.onmessage!({ data: JSON.stringify({ type: WS_HEARTBEAT_TYPE }) });
    socket.onmessage!({ data: JSON.stringify({ type: "agent_start" }) });
    socket.onmessage!({ data: "not json" });
    assertEquals(events, [{ type: "agent_start" }]);
    close();
    assertEquals(socket.closed, true);
  } finally {
    restore();
  }
});

Deno.test("openEventStream: closing through the returned function is not an outage", () => {
  const restore = installFakeSocket();
  try {
    let closed = 0;
    const close = openEventStream<{ type: string }>(
      { path: "/ws" },
      () => {},
      () => closed++,
    );
    const socket = FakeSocket.last!;
    close();
    // The socket's own close event arrives after the caller asked for it:
    // it must not be reported as a connection loss (which would reconnect).
    socket.onclose!();
    assertEquals(closed, 0);
  } finally {
    restore();
  }
});

Deno.test("openEventStream: a dropped socket reports the close", () => {
  const restore = installFakeSocket();
  try {
    let closed = 0;
    openEventStream<{ type: string }>(
      { path: "/stella/conversations/a/events" },
      () => {},
      () => closed++,
    );
    const socket = FakeSocket.last!;
    assertEquals(
      socket.url,
      "ws://127.0.0.1:8000/stella/conversations/a/events",
    );
    socket.onclose!();
    assertEquals(closed, 1);
  } finally {
    restore();
  }
});
