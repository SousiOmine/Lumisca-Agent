import { assertEquals, assertRejects } from "@std/assert";
import { HandoverHub } from "./handover.ts";
import type { ClientEvent } from "../types/event.ts";

/**
 * The screen hand-over: the wait, the events clients follow, and the ways it
 * ends. No machine is involved — the hub only owns the promise and the two
 * events.
 */

function hub(): { hub: HandoverHub; events: ClientEvent[] } {
  const events: ClientEvent[] = [];
  return {
    hub: new HandoverHub("s1", (event) => events.push(event)),
    events,
  };
}

Deno.test("handover: waiting announces the request and resolves on finish", async () => {
  const { hub: h, events } = hub();
  const waited = h.wait(
    "call-1",
    "Needs a password",
    "Type it and press Enter",
  );
  assertEquals(events.length, 1);
  assertEquals(events[0]!.type, "handover");
  if (events[0]!.type === "handover") {
    assertEquals(events[0]!.reason, "Needs a password");
    assertEquals(events[0]!.instructions, "Type it and press Enter");
  }
  assertEquals(h.pendingHandover()?.toolCallId, "call-1");

  h.finish("logged in");
  assertEquals(await waited, "logged in");
  assertEquals(events.at(-1)?.type, "handover_end");
  assertEquals(h.pendingHandover(), null);
});

Deno.test("handover: only one at a time", async () => {
  const { hub: h } = hub();
  const first = h.wait("call-1", "one", null);
  await assertRejects(
    () => h.wait("call-2", "two", null),
    Error,
    "already being asked",
  );
  h.finish("");
  await first;
});

Deno.test("handover: finishing when nothing waits is refused", () => {
  const { hub: h } = hub();
  let message = "";
  try {
    h.finish("nothing");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("No handover"), true);
});

Deno.test("handover: a mismatched tool call does not resolve the wait", async () => {
  const { hub: h } = hub();
  const waited = h.wait("call-1", "one", null);
  let message = "";
  try {
    h.finish("done", "call-2");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("call-2"), true);
  assertEquals(h.pendingHandover()?.toolCallId, "call-1");
  h.finish("");
  await waited;
});

Deno.test("handover: cancelling rejects the wait and clears the pane", async () => {
  const { hub: h, events } = hub();
  const waited = h.wait("call-1", "one", null);
  h.cancelAll();
  await assertRejects(() => waited, Error, "cancelled");
  assertEquals(h.pendingHandover(), null);
  const end = events.at(-1);
  assertEquals(end?.type, "handover_end");
  // Idempotent: the run's teardown may call it more than once.
  h.cancelAll();
});

Deno.test("handover: an already aborted signal never registers", async () => {
  const { hub: h, events } = hub();
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => h.wait("call-1", "one", null, controller.signal),
    Error,
  );
  assertEquals(h.pendingHandover(), null);
  assertEquals(events.length, 0);
});

Deno.test("handover: aborting the run settles the wait", async () => {
  const { hub: h } = hub();
  const controller = new AbortController();
  const waited = h.wait("call-1", "one", null, controller.signal);
  controller.abort();
  await assertRejects(() => waited, Error);
  assertEquals(h.pendingHandover(), null);
});
