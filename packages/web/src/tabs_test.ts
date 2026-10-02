import { assertEquals } from "@std/assert";
import { keysForPeer, splitTabKey, tabKey } from "./tabs.ts";

Deno.test("keysForPeer picks exactly one peer's tabs", () => {
  const keys = [
    "sess-1", // this server
    tabKey("peer-1", "sess-2"),
    tabKey("peer:1", "sess-3"), // an escaped peer id
    tabKey("peer-1", "sess:4"),
  ];
  assertEquals(keysForPeer(keys, "peer-1"), [
    tabKey("peer-1", "sess-2"),
    tabKey("peer-1", "sess:4"),
  ]);
  assertEquals(keysForPeer(keys, ""), ["sess-1"]);
  assertEquals(keysForPeer(keys, "peer:1"), [tabKey("peer:1", "sess-3")]);
  assertEquals(keysForPeer(keys, "missing"), []);
});

Deno.test("tabKey/splitTabKey round-trip every id shape", () => {
  // The peer id comes from the connection registry (the user writes it), so
  // it may carry the separator or the escape character; the session half is
  // a server-generated UUID and is taken verbatim.
  const cases: Array<[string, string]> = [
    ["", "sess-1"],
    ["peer-1", "sess-1"],
    ["peer:1", "sess-1"],
    ["a:b:c", "sess-1"],
    ["50%off", "sess-1"],
    ["a%3Ab", "sess-1"],
    ["100%:x", "sess-1"],
    ["peer-1", "sess:2"],
  ];
  for (const [peerId, sessionId] of cases) {
    assertEquals(
      splitTabKey(tabKey(peerId, sessionId)),
      { peerId, sessionId },
      `${peerId} / ${sessionId}`,
    );
  }
});

Deno.test("a key without a separator belongs to this server", () => {
  assertEquals(splitTabKey("sess-1"), { peerId: "", sessionId: "sess-1" });
  assertEquals(tabKey("", "sess-1"), "sess-1");
});
