import { assertEquals } from "@std/assert";
import {
  type CloseOperation,
  closeTargets,
  keysForPeer,
  splitTabKey,
  tabKey,
} from "./tabs.ts";

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

Deno.test("closeTargets names each operation's tabs in tab order", () => {
  const tabs = ["a", "b", "c", "d"];
  assertEquals(closeTargets("tab", tabs, "c"), ["c"]);
  assertEquals(closeTargets("toRight", tabs, "b"), ["c", "d"]);
  assertEquals(closeTargets("toLeft", tabs, "b"), ["a"]);
  assertEquals(closeTargets("others", tabs, "b"), ["a", "c", "d"]);
  // The outermost tabs close nothing beyond themselves.
  assertEquals(closeTargets("toRight", tabs, "d"), []);
  assertEquals(closeTargets("toLeft", tabs, "a"), []);
  // A lone tab has no others to close.
  assertEquals(closeTargets("others", ["a"], "a"), []);
});

Deno.test("closeTargets: a stale anchor targets nothing to the sides", () => {
  const tabs = ["a", "b"];
  for (const op of ["toRight", "toLeft"] as CloseOperation[]) {
    assertEquals(closeTargets(op, tabs, "gone"), [], op);
  }
  // The plain close names the tab it was asked about (the click pointed at
  // it), and "others" is everybody but that anchor — id or not.
  assertEquals(closeTargets("tab", tabs, "gone"), ["gone"]);
  assertEquals(closeTargets("others", tabs, "gone"), ["a", "b"]);
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
