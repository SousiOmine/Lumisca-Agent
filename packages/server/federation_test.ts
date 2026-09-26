import { assertEquals } from "@std/assert";
import type { ConnectionEntry } from "@lumisca/core";
import { FederationClient } from "./federation.ts";

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
