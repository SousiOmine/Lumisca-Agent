import { assertEquals } from "@std/assert";
import {
  parseStoredRecents,
  RECENT_MODEL_LIMIT,
  recentsOf,
  withRecentModel,
} from "./recentModels.ts";

/** The rules the picker's recent section depends on: newest first, one row
 * per model, a short list, and a value that never throws (it lives in a
 * browser profile the app does not control). */

Deno.test("stored recents: a pick moves to the front", () => {
  const raw = withRecentModel(null, "", { provider: "a", modelId: "1" });
  const twice = withRecentModel(raw, "", { provider: "b", modelId: "2" });
  assertEquals(recentsOf(twice, ""), [
    { provider: "b", modelId: "2" },
    { provider: "a", modelId: "1" },
  ]);
  // The same pick again does not appear twice: it is the newest, not another
  // entry.
  const again = withRecentModel(twice, "", { provider: "a", modelId: "1" });
  assertEquals(recentsOf(again, ""), [
    { provider: "a", modelId: "1" },
    { provider: "b", modelId: "2" },
  ]);
});

Deno.test("stored recents: the list stops at the limit", () => {
  let raw: string | null = null;
  for (let i = 0; i < RECENT_MODEL_LIMIT + 3; i++) {
    raw = withRecentModel(raw, "", { provider: "p", modelId: `m${i}` });
  }
  const list = recentsOf(raw, "");
  assertEquals(list.length, RECENT_MODEL_LIMIT);
  // The newest is kept and the oldest is the one dropped.
  assertEquals(list[0]!.modelId, `m${RECENT_MODEL_LIMIT + 2}`);
  assertEquals(list.some((m) => m.modelId === "m0"), false);
});

Deno.test("stored recents: peers keep separate lists", () => {
  const raw = withRecentModel(null, "", { provider: "a", modelId: "1" });
  const peer = withRecentModel(raw, "peer-1", { provider: "b", modelId: "2" });
  assertEquals(recentsOf(peer, ""), [{ provider: "a", modelId: "1" }]);
  assertEquals(recentsOf(peer, "peer-1"), [{ provider: "b", modelId: "2" }]);
  // A peer that never picked anything is an empty list, not the local one.
  assertEquals(recentsOf(peer, "peer-2"), []);
});

Deno.test("stored recents: a malformed value is an empty list, not a throw", () => {
  assertEquals(parseStoredRecents(null), {});
  assertEquals(parseStoredRecents(""), {});
  assertEquals(parseStoredRecents("not json"), {});
  assertEquals(parseStoredRecents("null"), {});
  assertEquals(parseStoredRecents(`["a"]`), {});
  assertEquals(parseStoredRecents(`{"":["x"]}`), { "": [] });
  // Entries that are not a provider/modelId pair are skipped, and the ones
  // that are survive.
  assertEquals(
    parseStoredRecents(
      `{"":[{"provider":"a","modelId":"1"},null,{"provider":"b"},` +
        `{"provider":"","modelId":"x"},{"provider":"a","modelId":"1"}]}`,
    ),
    { "": [{ provider: "a", modelId: "1" }] },
  );
});
