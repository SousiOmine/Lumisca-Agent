import { assertEquals, assertRejects } from "@std/assert";
import type { ClientEvent } from "../domain/event.ts";
import { HandoverHub } from "./handover.ts";

/**
 * The screen hand-over: the wait, the events clients follow, and the ways it
 * ends. No machine is involved — the hub only owns the promise, the timer
 * and the two events. Deadlines are exercised with a short `timeoutMs`
 * instead of waiting the real one.
 */

function hub(timeoutMs?: number): {
  hub: HandoverHub;
  events: ClientEvent[];
} {
  const events: ClientEvent[] = [];
  return {
    hub: new HandoverHub("s1", (event) => events.push(event), timeoutMs),
    events,
  };
}

Deno.test("handover: waiting announces the request and resolves on finish", async () => {
  const { hub: h, events } = hub();
  const before = Date.now();
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
    // The deadline travels with the request: a client that reconnects
    // mid-wait reads it from the snapshot, and this is where it is set.
    assertEquals(events[0]!.expiresAt >= before, true);
  }
  assertEquals(h.pendingHandover()?.toolCallId, "call-1");
  assertEquals(
    h.pendingHandover()?.expiresAt,
    events[0]!.type === "handover" ? events[0]!.expiresAt : -1,
  );

  h.finish("logged in");
  assertEquals(await waited, { kind: "finished", note: "logged in" });
  assertEquals(events.at(-1)?.type, "handover_end");
  assertEquals(h.pendingHandover(), null);
});

Deno.test("handover: the deadline hands the run back without an answer", async () => {
  // The user never comes. The wait must end on its own and say so — the
  // run continues, it is not stopped (#36).
  const { hub: h, events } = hub(20);
  const waited = h.wait("call-1", "Needs a password", null);
  assertEquals(await waited, { kind: "timed_out" });

  // The pane stops being interactive BEFORE the run moves on: the agent
  // must not start clicking while the user could still be at the screen.
  const end = events.at(-1);
  assertEquals(end?.type, "handover_end");
  if (end?.type === "handover_end") {
    assertEquals(end.toolCallId, "call-1");
    assertEquals(end.note, "");
  }
  assertEquals(h.pendingHandover(), null);

  // A late click is refused rather than silently accepted.
  let message = "";
  try {
    h.finish("done");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("No handover"), true);
});

Deno.test("handover: a settled wait leaves no timer behind", async () => {
  // The deadline timer keeps running in the background; a leaked one would
  // fire later and emit a second `handover_end`, closing a pane the user is
  // no longer handing over.
  const { hub: h, events } = hub(20);
  const first = h.wait("call-1", "one", null);
  h.finish("");
  assertEquals(await first, { kind: "finished", note: "" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(events.filter((e) => e.type === "handover_end").length, 1);
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
