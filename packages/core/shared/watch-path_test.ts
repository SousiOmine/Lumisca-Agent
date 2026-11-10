import { assertEquals } from "@std/assert";
import {
  MAX_WATCH_IDS,
  resolveWatchPath,
  watchIdsFrom,
  watchPathProblem,
} from "./watch-path.ts";

const INBOX = {
  data: {
    count: 2,
    messages: [
      { id: "m1", subject: "first" },
      { id: 42, subject: "second" },
    ],
  },
};

Deno.test("watch path: a mapped field yields one value per item", () => {
  assertEquals(resolveWatchPath(INBOX, "data.messages[].id"), ["m1", 42]);
  assertEquals(resolveWatchPath(INBOX, "data.messages[].subject"), [
    "first",
    "second",
  ]);
  assertEquals(resolveWatchPath(INBOX, "data.count"), 2);
  // The whole object when the path stops at one.
  assertEquals(resolveWatchPath(INBOX, "data.messages[].id"), ["m1", 42]);
});

Deno.test("watch path: a path that names nothing is undefined", () => {
  assertEquals(resolveWatchPath(INBOX, "data.missing"), undefined);
  assertEquals(resolveWatchPath(INBOX, "data.count.deeper"), undefined);
  // `[]` over a value that is not an array is not an empty list: the watch
  // names the wrong field, and saying "no items" would hide it.
  assertEquals(resolveWatchPath(INBOX, "data.count[].id"), undefined);
  assertEquals(resolveWatchPath(null, "data"), undefined);
  assertEquals(resolveWatchPath([], "data"), undefined);
});

Deno.test("watch path: ids are strings and numbers, in order", () => {
  assertEquals(watchIdsFrom(INBOX, "data.messages[].id"), ["m1", "42"]);
  assertEquals(watchIdsFrom({ ids: [] }, "ids"), []);
  // An object in the list means the path stopped one level too high: that is
  // not an id.
  assertEquals(
    watchIdsFrom({ items: [{ id: { nested: true } }] }, "items[].id"),
    undefined,
  );
  assertEquals(watchIdsFrom(INBOX, "data.count"), undefined);
});

Deno.test("watch path: the stored window is bounded", () => {
  const many = {
    items: Array.from({ length: MAX_WATCH_IDS + 50 }, (_, index) => ({
      id: `i${index}`,
    })),
  };
  const ids = watchIdsFrom(many, "items[].id");
  assertEquals(ids?.length, MAX_WATCH_IDS);
  assertEquals(ids?.[0], "i0");
  assertEquals(ids?.at(-1), `i${MAX_WATCH_IDS - 1}`);
});

Deno.test("watch path: only the accepted shape is a path", () => {
  assertEquals(watchPathProblem("data.messages[].id"), null);
  assertEquals(watchPathProblem("ids"), null);
  assertEquals(
    watchPathProblem(""),
    'a field path such as "data.messages[].id"',
  );
  assertEquals(
    watchPathProblem(undefined),
    'a field path such as "data.messages[].id"',
  );
  assertEquals(watchPathProblem("data..id") !== null, true);
  assertEquals(watchPathProblem("data.messages[0].id") !== null, true);
  assertEquals(watchPathProblem("data.messages[]") !== null, false);
  assertEquals(watchPathProblem("data[].messages[].id"), null);
});
