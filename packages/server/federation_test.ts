import { assertEquals } from "@std/assert";
import type { ConnectionEntry } from "@lumisca/core";
import { FederationClient } from "./federation.ts";

/** The first reconnect backoff the restart test gives the client. Small
 * enough that a leaked stream would retry many times during the wait, so the
 * test still proves the leak; short enough that it costs milliseconds. */
const RECONNECT_BASE_MS_FOR_TEST = 20;

/** A registry entry as the settings store holds it; only `url` matters to
 * the self-check. */
function peer(url: string): ConnectionEntry {
  return { id: url, name: url, url, token: "t" };
}

/** The peer URLs the hub would show for these registry entries. */
function visiblePeers(
  selfOrigin: string,
  urls: readonly string[],
): string[] {
  const client = new FederationClient(
    () => urls.map(peer),
    () => selfOrigin,
  );
  return client.peers().map((p) => p.url);
}

/** Every spelling a user can end up with for the same local server: the
 * bind address, the name in the systemd output, and the bracketed IPv6
 * literal `URL.hostname` reports (`connectionUrls` prints it too). */
const SPELLINGS = ["127.0.0.1", "localhost", "[::1]"];

Deno.test("federation: the hub recognises itself under every loopback spelling", () => {
  for (const selfHost of SPELLINGS) {
    for (const peerHost of SPELLINGS) {
      assertEquals(
        visiblePeers(`http://${selfHost}:8000`, [`http://${peerHost}:8000`]),
        [],
        `${peerHost} must be the hub bound to ${selfHost}, not a remote peer`,
      );
    }
  }
});

Deno.test("federation: a wildcard bind's loopback origin still matches", () => {
  // `app.ts` builds the hub's own origin with `hostForUrl`, which maps a
  // `::` bind to `[::1]`; a bare concatenation produced `http://:::8000`,
  // which is not a URL — so no peer was ever seen as the hub.
  assertEquals(
    visiblePeers("http://[::1]:8000", [
      "http://[::1]:8000",
      "http://127.0.0.1:8000",
      "http://localhost:8000",
    ]),
    [],
  );
});

Deno.test("federation: another port on loopback stays a peer", () => {
  // The desktop-managed server (8000) and a resident one (8100) are two
  // servers on one machine; the self-check must hide only the first.
  assertEquals(
    visiblePeers("http://127.0.0.1:8000", [
      "http://127.0.0.1:8100",
      "http://[::1]:8100",
    ]),
    ["http://127.0.0.1:8100", "http://[::1]:8100"],
  );
});

Deno.test("federation: remote peers are never mistaken for the hub", () => {
  assertEquals(
    visiblePeers("http://127.0.0.1:8000", [
      "http://100.64.0.5:8000",
      "https://example.com:8000",
    ]),
    ["http://100.64.0.5:8000", "https://example.com:8000"],
  );
});

Deno.test("federation: without a known origin every peer is listed", () => {
  // The origin is only known after the listener binds (port 0 =
  // ephemeral); until then nothing may be hidden.
  assertEquals(
    visiblePeers("", ["http://127.0.0.1:8000"]),
    ["http://127.0.0.1:8000"],
  );
});

/** Poll until `done()` or a 2s deadline: the streams connect (and drop)
 * asynchronously. */
async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test("federation: a peer's stream state is relayed to the UI", async () => {
  // A stub peer with one WebSocket endpoint the test can drop. The hub must
  // announce the stream's state: while its relay to a peer is down, the
  // peer's sessions miss events, and the UI's own socket to the hub says
  // nothing about it.
  const sockets = new Set<WebSocket>();
  const peerServer = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Keep the test output clean: the stub's address is not interesting.
    onListen: () => {},
  }, (req) => {
    if (new URL(req.url).pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    sockets.add(socket);
    socket.onclose = () => sockets.delete(socket);
    return response;
  });
  const peerUrl = `http://127.0.0.1:${(peerServer.addr as Deno.NetAddr).port}`;
  const client = new FederationClient(
    () => [{ id: "peer1", name: "peer1", url: peerUrl, token: "t" }],
    // Never this stub (port 1 is unbound), so the peer stays visible.
    () => "http://127.0.0.1:1",
  );
  const states: boolean[] = [];
  client.subscribe((peerId, event) => {
    if (event.type === "peer_stream" && event.peerId === peerId) {
      states.push(event.connected);
    }
  });
  client.start();
  try {
    await waitFor(() => states.length >= 1);
    assertEquals(states[0], true, "the opened relay is announced");

    for (const socket of [...sockets]) socket.close();
    await waitFor(() => states.length >= 2);
    assertEquals(states[1], false, "the dropped relay is announced");
  } finally {
    client.close();
    await peerServer.shutdown();
  }
});

Deno.test("federation: restart leaves one live stream per peer", async () => {
  // The registry was re-saved: restart() drops the old streams and opens new
  // ones. A dropped stream must not schedule a reconnect of its own — the
  // orphan socket relays the peer's events a second time and nothing keeps a
  // reference to close it.
  let connections = 0;
  const peerServer = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    if (new URL(req.url).pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    connections++;
    return Deno.upgradeWebSocket(req).response;
  });
  const peerUrl = `http://127.0.0.1:${(peerServer.addr as Deno.NetAddr).port}`;
  const client = new FederationClient(
    () => [{ id: "peer1", name: "peer1", url: peerUrl, token: "t" }],
    // Never this stub, so the peer stays visible.
    () => "http://127.0.0.1:1",
    // A 20ms first backoff: the orphan this test hunts for would dial in
    // again several times over the wait below, and the wait stays cheap.
    // (It used to be 2.5s of real time against the production 2s delay.)
    { reconnectBaseMs: RECONNECT_BASE_MS_FOR_TEST },
  );
  try {
    client.start();
    await waitFor(() => connections === 1);
    client.restart();
    await waitFor(() => connections === 2);
    assertEquals(connections, 2, "the restarted peer is connected once");
    // Past the backoff (and a few multiples of it): an orphaned stream would
    // dial in again here, and keep doing so.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEquals(connections, 2, "the dropped stream must not reconnect");
  } finally {
    client.close();
    await peerServer.shutdown();
  }
});

Deno.test("federation: a frame the peer relayed from its own peer is not relayed again", async () => {
  // `/ws` stamps every frame it sends: "" for an event of the server itself,
  // the source peer's id for one it relayed. A hub that relays the second
  // kind again sends the same event twice, and when the "peer" is the hub
  // under another URL, the relayed copy comes back as an input and the relay
  // never stops: the loop pegged a core and grew the process until the OOM
  // killer took it down (taking every session with it).
  const peerServer = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    if (new URL(req.url).pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "agent_end",
        sessionId: "local",
        peerId: "",
      }));
      socket.send(JSON.stringify({
        type: "agent_end",
        sessionId: "relayed",
        peerId: "someone-else",
      }));
    };
    return response;
  });
  const peerUrl = `http://127.0.0.1:${(peerServer.addr as Deno.NetAddr).port}`;
  const client = new FederationClient(
    () => [{ id: "peer1", name: "peer1", url: peerUrl, token: "t" }],
    () => "http://127.0.0.1:1",
  );
  const sessionIds: string[] = [];
  client.subscribe((_peerId, event) => {
    if (event.type === "agent_end") sessionIds.push(event.sessionId);
  });
  client.start();
  try {
    await waitFor(() => sessionIds.length >= 1);
    // Past the point the second frame would have arrived: the relayed copy
    // must never reach a listener.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(sessionIds, ["local"]);
  } finally {
    client.close();
    await peerServer.shutdown();
  }
});

Deno.test("federation: the hub recognises itself under any URL", async () => {
  // The URL check recognises loopback aliases only. The same server is also
  // reachable as its tailnet name — which is exactly what the settings'
  // connection list holds, because that list is the user's servers to switch
  // to — and a hub that federates with itself there is the echo above. Its
  // identity is its instanceId (a per-process uuid), not its address.
  const selfId = crypto.randomUUID();
  const sockets = new Set<WebSocket>();
  const peerServer = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/api/health") {
      return Response.json({ ok: true, now: Date.now(), instanceId: selfId });
    }
    if (path === "/ws") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      sockets.add(socket);
      socket.onclose = () => sockets.delete(socket);
      return response;
    }
    return new Response("not found", { status: 404 });
  });
  const url = `http://127.0.0.1:${(peerServer.addr as Deno.NetAddr).port}`;
  const client = new FederationClient(
    () => [{ id: "self", name: "self", url, token: "t" }],
    // The stub is not this origin: only the identity probe can tell.
    () => "http://127.0.0.1:1",
    { reconnectBaseMs: RECONNECT_BASE_MS_FOR_TEST, selfId: () => selfId },
  );
  client.start();
  try {
    await waitFor(() => client.peers().length === 0);
    assertEquals(client.peers(), [], "the hub's own entry is not a peer");
    // Not one event stream may be opened, and nothing may dial in later.
    assertEquals(sockets.size, 0, "the hub must not federate with itself");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(sockets.size, 0, "the hub must not federate with itself");
  } finally {
    client.close();
    await peerServer.shutdown();
  }
});
