import { assertEquals } from "@std/assert";
import { splitTabKey, tabKey } from "./tabs.ts";

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
