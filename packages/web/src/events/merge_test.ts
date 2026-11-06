import { assert, assertEquals } from "@std/assert";
import {
  type LoadedWindow,
  mergeNewestWindow,
  prependHistoricWindow,
  prependOlderWindow,
} from "./merge.ts";

/** One item of a synthetic transcript: an identity and the order it holds. */
interface Item {
  key: string;
  at: number;
}

const rules = { key: (item: Item) => item.key };
const timed = { ...rules, timestamp: (item: Item) => item.at };

const item = (key: string, at: number): Item => ({ key, at });

function window(
  keys: string[],
  older: string | null = null,
): LoadedWindow<Item> {
  return { items: keys.map((key, index) => item(key, index + 1)), older };
}

Deno.test("merge: the newest window is folded in, keeping both sides' order", () => {
  // The client holds 1,2,3; the resync re-reads 2,3,4. The overlap names
  // where the new item goes: after what it has, not before it.
  const merged = mergeNewestWindow(
    window(["1", "2", "3"]),
    window(["2", "3", "4"]),
    rules,
  );
  assertEquals(merged.items.map((i) => i.key), ["1", "2", "3", "4"]);
});

Deno.test("merge: a window that shares no item replaces the history", () => {
  // A hole left in the middle would be worse than losing the scroll
  // position: the reader would page into history the view cannot show.
  const merged = mergeNewestWindow(
    window(["1", "2"], "before-1"),
    window(["8", "9"], "before-8"),
    rules,
  );
  assertEquals(merged.items.map((i) => i.key), ["8", "9"]);
  assertEquals(merged.older, "before-8");
});

Deno.test("merge: an empty window changes nothing", () => {
  const history = window(["1", "2"], "cursor");
  assertEquals(mergeNewestWindow(history, window([], "other"), rules), history);
});

Deno.test("merge: an empty history takes the window whole", () => {
  const merged = mergeNewestWindow(window([]), window(["1", "2"], "c"), rules);
  assertEquals(merged.items.map((i) => i.key), ["1", "2"]);
  assertEquals(merged.older, "c");
});

Deno.test("merge: an item spliced into the middle lands in its place", () => {
  // Compaction inserts a checkpoint between two items the client holds, and
  // it must go exactly there.
  const merged = mergeNewestWindow(
    window(["1", "3"]),
    window(["1", "2", "3"]),
    rules,
  );
  assertEquals(merged.items.map((i) => i.key), ["1", "2", "3"]);
});

Deno.test("merge: the cursor stays the client's while its front survives", () => {
  const merged = mergeNewestWindow(
    window(["1", "2"], "before-1"),
    window(["2", "3"], "before-2"),
    rules,
  );
  assertEquals(merged.older, "before-1");
});

Deno.test("merge: the cursor follows the window that reached further back", () => {
  const merged = mergeNewestWindow(
    window(["2", "3"], "before-2"),
    window(["1", "2", "3"], "before-1"),
    rules,
  );
  assertEquals(merged.older, "before-1");
});

Deno.test("merge: a duplicated key consumes one anchor per incoming copy", () => {
  // With multiAnchor, two view items sharing a key are matched in order: the
  // first incoming copy anchors on the first, the second on the second. A
  // single anchor would pile both on the last one, and every resync would
  // insert the same rows again.
  const merged = mergeNewestWindow(
    window(["a", "b", "b"]),
    window(["b", "b"]),
    { ...rules, multiAnchor: true },
  );
  assertEquals(merged.items.map((i) => i.key), ["a", "b", "b"]);
});

Deno.test("merge: without multiAnchor one key matches one position", () => {
  const merged = mergeNewestWindow(
    window(["a", "b", "b"]),
    window(["b"]),
    rules,
  );
  assertEquals(merged.items.map((i) => i.key), ["a", "b", "b"]);
});

Deno.test("merge: a repeated resync does not grow the history", () => {
  const history = window(["1", "2", "3"]);
  const fetched = window(["2", "3", "4"]);
  const once = mergeNewestWindow(history, fetched, rules);
  const twice = mergeNewestWindow(once, fetched, rules);
  assertEquals(twice.items.length, once.items.length);
});

Deno.test("merge: an item the view holds earlier is not written twice", () => {
  // A prompt steered into a running turn is announced when it is typed and
  // stored after the turn it joined, so the view holds it above rows the
  // transcript puts before it. Anchoring on it would walk the cursor
  // backwards; the merge must keep the view's position and emit each row
  // once, including the one that arrived after the reordered region.
  const merged = mergeNewestWindow(
    window(["p", "a", "t", "b"]),
    window(["a", "t", "p", "b", "c"]),
    { ...rules, multiAnchor: true },
  );
  assertEquals(merged.items.map((i) => i.key), ["p", "a", "t", "b", "c"]);
});

Deno.test("prepend: a page goes in front, and a known page ends the walk", () => {
  const first = prependOlderWindow(
    window(["3", "4"]),
    [item("1", 1), item("2", 2)],
    "before-1",
    rules,
  );
  assertEquals(first.items.map((i) => i.key), ["1", "2", "3", "4"]);
  assertEquals(first.older, "before-1");
  // The server answered with a page the client already holds: walking again
  // would land on the same rows forever.
  const again = prependOlderWindow(first, [item("2", 2)], "before-2", rules);
  assertEquals(again.older, null);
  assertEquals(again.items.length, 4);
});

Deno.test("prepend: an empty page ends the walk", () => {
  const page = prependOlderWindow(window(["1"]), [], null, rules);
  assertEquals(page.older, null);
});

Deno.test("prepend historic: live items above the page are not inserted", () => {
  // The page was asked for by a cursor, and the conversation grew while the
  // answer was on its way. The new item belongs to the live edge, not above
  // the reader's history (inserting it there duplicated it on the next
  // event).
  const merged = prependHistoricWindow(
    { items: [item("3", 3), item("9", 9)], older: "before-3" },
    [item("1", 1), item("2", 2), item("9", 9)],
    "before-1",
    timed,
  );
  assertEquals(merged.items.map((i) => i.key), ["1", "2", "3", "9"]);
});

Deno.test("prepend historic: the page stops at the first item the client holds", () => {
  const merged = prependHistoricWindow(
    { items: [item("3", 3)], older: "before-3" },
    [item("1", 1), item("2", 2), item("3", 3), item("4", 4)],
    "before-1",
    timed,
  );
  assertEquals(merged.items.map((i) => i.key), ["1", "2", "3"]);
});

Deno.test("prepend historic: a page that adds nothing ends the walk", () => {
  const merged = prependHistoricWindow(
    { items: [item("3", 3)], older: "before-3" },
    [item("3", 3)],
    "before-3",
    timed,
  );
  assertEquals(merged.older, null);
  assert(merged.items.length === 1);
});
