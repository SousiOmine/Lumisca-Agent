import { assertEquals } from "@std/assert";
import { type DraftStartState, startDraft } from "./draftStart.ts";

/**
 * What the screen's send button depends on: the flag is released when the
 * request settles, whatever it settled to. The screen is kept mounted after
 * a start (see components/SessionPane), so a flag left set is what the next
 * "+" inherits — this is the regression that made the new-session screen
 * unusable for the rest of the page's life.
 */

/** Records the writes in order, with the values the screen would show. */
function recorder() {
  const writes: string[] = [];
  let busy = false;
  let error: string | undefined = "stale";
  const state: DraftStartState = {
    busy: (value) => {
      busy = value;
      writes.push(`busy:${value}`);
    },
    error: (message) => {
      error = message;
      writes.push(`error:${message}`);
    },
  };
  return { state, writes, busy: () => busy, error: () => error };
}

const describe = () => "理由";

Deno.test("startDraft: a start that succeeds releases the flag", async () => {
  const { state, writes, busy, error } = recorder();
  let ran = 0;
  await startDraft(
    () => {
      ran += 1;
      return Promise.resolve();
    },
    state,
    describe,
  );
  assertEquals(ran, 1);
  assertEquals(writes, ["busy:true", "error:undefined", "busy:false"]);
  assertEquals(busy(), false);
  assertEquals(error(), undefined);
});

Deno.test("startDraft: a start that fails releases the flag too", async () => {
  const { state, writes, busy, error } = recorder();
  let described = 0;
  await startDraft(
    () => Promise.reject(new Error("network down")),
    state,
    (failure) => {
      described += 1;
      assertEquals((failure as Error).message, "network down");
      return "理由";
    },
  );
  assertEquals(described, 1);
  assertEquals(writes, [
    "busy:true",
    "error:undefined",
    "error:理由",
    "busy:false",
  ]);
  assertEquals(busy(), false);
  assertEquals(error(), "理由");
});

Deno.test("startDraft: the next start clears the previous reason", async () => {
  const { state, error } = recorder();
  await startDraft(() => Promise.reject(new Error("first")), state, describe);
  assertEquals(error(), "理由");
  await startDraft(() => Promise.resolve(), state, describe);
  assertEquals(error(), undefined);
});
