import { assert, assertEquals } from "@std/assert";
import { disposeServer } from "./app.ts";
import { setup } from "./test-utils.ts";

/** A session id the hub keys loans by. Nothing validates it: a loan belongs to
 * a conversation, and the hub only groups by the id the app was told. */
const SESSION = "sess-1";

/** Poll until `check` holds: the socket and the hub live in different turns of
 * the event loop, so a frame's effect is not there the instant it was sent. */
async function until(check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A grant as the lending app announces it. */
function grant(sessionId: string = SESSION) {
  return {
    id: "g1",
    sessionId,
    name: "proj",
    path: "/Users/me/proj",
    host: { platform: "macos", name: "mac", shell: "zsh" },
    write: true,
    expiresAt: Date.now() + 60_000,
  };
}

/** Connect to the lending socket and wait until the server accepts. */
async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/share/host`);
  await new Promise<void>((resolve) => {
    socket.onopen = () => resolve();
  });
  return socket;
}

Deno.test("a lending app's folders reach the session it lent them to", async () => {
  const { core, server } = setup();
  const socket = await connect(server.addr.port);
  try {
    // The session's event stream sees the loan as a whole list, so a client
    // can draw it (and a frame lost in transit cannot leave half a loan).
    const events = new WebSocket(`ws://127.0.0.1:${server.addr.port}/ws`);
    const loans: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => {
      events.onopen = () => resolve();
    });
    events.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === "shares") loans.push(frame);
    };

    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "app-1",
        host: { platform: "macos", name: "mac", shell: "zsh" },
        grants: [grant()],
      }),
    );
    await until(
      () => core.shares.grantsFor(SESSION).length === 1,
      "the loan to be registered",
    );
    assertEquals(
      core.shares.sharesFor(SESSION).map((share) => share.name),
      ["proj"],
    );
    await until(() => loans.length === 1, "the shares event");
    assertEquals(loans[0]?.sessionId, SESSION);

    // A file call becomes one frame, and the app's answer is the call's
    // result: this is the whole channel a tool crosses.
    const frames: Record<string, unknown>[] = [];
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "op") {
        socket.send(
          JSON.stringify({
            type: "result",
            id: frame.id,
            ok: true,
            value: { text: "lent", size: 4 },
          }),
        );
      }
    };
    const read = await core.shares.call("g1", "readText", {
      path: ["a.txt"],
      maxBytes: 10,
    });
    assertEquals(read.text, "lent");
    assertEquals(frames[0]?.type, "op");
    assertEquals(frames[0]?.grant, "g1");

    // Withdrawing the loan empties the list for that session.
    socket.send(JSON.stringify({ type: "grants", grants: [] }));
    await until(
      () => core.shares.grantsFor(SESSION).length === 0,
      "the withdrawal",
    );
    await until(() => loans.length === 2, "the withdrawal's event");
    assertEquals(loans[1]?.shares, []);
    events.close();
  } finally {
    socket.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
  }
});

Deno.test("a frame the server cannot read is ignored, not fatal", async () => {
  const { core, server } = setup();
  const socket = await connect(server.addr.port);
  try {
    socket.send("not json at all");
    socket.send(JSON.stringify({ type: "grants", grants: "nope" }));
    // The socket is still usable: a version mismatch must not take the server
    // (or the next honest frame) down with it.
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "app-1",
        host: { platform: "linux", name: "box", shell: "sh" },
        grants: [],
      }),
    );
    await until(
      () => core.shares.connections().length === 1,
      "the connection to be registered",
    );
    assert(core.shares.connections()[0]?.clientId === "app-1");
  } finally {
    socket.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
  }
});

Deno.test("closing the socket ends every loan it carried", async () => {
  const { core, server } = setup();
  const socket = await connect(server.addr.port);
  try {
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "app-1",
        host: { platform: "macos", name: "mac", shell: "zsh" },
        grants: [grant()],
      }),
    );
    await until(
      () => core.shares.grantsFor(SESSION).length === 1,
      "the loan to be registered",
    );
    socket.close();
    await until(
      () => core.shares.grantsFor(SESSION).length === 0,
      "the loan to end with the socket",
    );
  } finally {
    socket.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
  }
});
