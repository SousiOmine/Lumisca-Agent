import { assert, assertEquals } from "@std/assert";
import type { WatchSource } from "../shared/routine.ts";
import { parseWatchState, runWatch, type WatchState } from "../vm/watch.ts";

/** A watch on a mailbox's message ids: the shape the compose flow produces
 * for Composio's Gmail tools. */
const inboxWatch: Extract<WatchSource, { kind: "mcp" }> = {
  kind: "mcp",
  server: "composio",
  tool: "GMAIL_FETCH_EMAILS",
  args: { query: "is:unread" },
  expect: { ids: "data.messages[].id" },
};

/** A tool answer as `McpManager.callTool` gives it: the JSON as text. */
function answer(result: unknown): Promise<string> {
  return Promise.resolve(JSON.stringify(result));
}

function inbox(...ids: string[]): Promise<string> {
  return answer({ data: { messages: ids.map((id) => ({ id })) } });
}

/** One check: the source's callTool answers with `call`. */
function check(
  previous: WatchState | undefined,
  call: (...args: unknown[]) => Promise<string>,
) {
  return runWatch(inboxWatch, previous, { callTool: call });
}

Deno.test("mcp watch: the first look is a baseline, never a change", async () => {
  const first = await check(undefined, () => inbox("m1", "m2"));
  assertEquals(first.changed, false);
  assertEquals(first.state, { kind: "mcp", ids: ["m1", "m2"], hash: null });
});

Deno.test("mcp watch: a new id fires, and the count comes with it", async () => {
  const first = await check(undefined, () => inbox("m1", "m2"));
  const next = await check(first.state!, () => inbox("m3", "m2", "m1"));
  assertEquals(next.changed, true);
  assertEquals(next.newItems, 1);
});

Deno.test("mcp watch: an edited or removed item is not a change", async () => {
  // A mailbox that fires when mail is read or deleted would fire on every
  // check; only a new id is the event.
  const first = await check(undefined, () => inbox("m1", "m2"));
  assertEquals((await check(first.state!, () => inbox("m1"))).changed, false);
  assertEquals(
    (await check(
      first.state!,
      () =>
        answer({
          data: { messages: [{ id: "m1", read: true }, { id: "m2" }] },
        }),
    )).changed,
    false,
  );
});

Deno.test("mcp watch: a hash watch compares the value at the path", async () => {
  const source: Extract<WatchSource, { kind: "mcp" }> = {
    ...inboxWatch,
    expect: { hash: "data.count" },
  };
  const deps = (count: number) => ({
    callTool: () => answer({ data: { count } }),
  });
  const first = await runWatch(source, undefined, deps(2));
  assert(first.state?.kind === "mcp");
  assertEquals((await runWatch(source, first.state, deps(2))).changed, false);
  assertEquals((await runWatch(source, first.state, deps(3))).changed, true);
  // The value, not the whole answer: an unrelated field changing under the
  // same count is not what this watch asks about.
  assertEquals(
    (await runWatch(source, first.state, {
      callTool: () => answer({ data: { count: 2, cursor: "next" } }),
    })).changed,
    false,
  );
});

Deno.test("mcp watch: an answer with no JSON is a problem, not a change", async () => {
  const result = await check(undefined, () => Promise.resolve("Deploy is OK"));
  assertEquals(result.state, null);
  assert(result.problem?.includes("not JSON") === true);
  assertEquals(result.changed, false);
});

Deno.test("mcp watch: a failed call is a problem, not a change", async () => {
  const result = await check(
    undefined,
    () => Promise.reject(new Error("Unauthorized")),
  );
  assertEquals(result.state, null);
  assert(result.problem?.includes("Unauthorized") === true);
  assertEquals(result.changed, false);
});

Deno.test("mcp watch: a path with nothing at it is a problem", async () => {
  const result = await check(undefined, () => answer({ data: {} }));
  assertEquals(result.state, null);
  assert(result.problem?.includes("data.messages[].id") === true);
});

Deno.test("mcp watch: the stored state survives the row's JSON", () => {
  const state: WatchState = { kind: "mcp", ids: ["m1", "m2"], hash: null };
  assertEquals(
    parseWatchState(JSON.parse(JSON.stringify(state))),
    state,
  );
  // A row edited by hand reads as "no baseline", so the next check records
  // one instead of comparing against half a list.
  assertEquals(parseWatchState({ kind: "mcp", ids: ["m1", 2] }), undefined);
  assertEquals(parseWatchState({ kind: "mcp" }), undefined);
});
