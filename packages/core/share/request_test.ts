import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ClientEvent } from "../domain/event.ts";
import { CoreError } from "../errors.ts";
import { ShareRequestHub, ShareRequestRegistry } from "./request.ts";

/**
 * The folder requests: the two waits, the events clients follow, and the ways
 * they end. Nothing here lends anything — the hub owns the promise, the timer
 * and the events; the desktop app and the server's list of loans arrive as
 * `finish*` calls. Deadlines are exercised with a short timeout instead of
 * waiting the real one.
 */

function hub(timeouts: { lend?: number; disconnect?: number } = {}): {
  hub: ShareRequestHub;
  events: ClientEvent[];
} {
  const events: ClientEvent[] = [];
  return {
    hub: new ShareRequestHub("s1", (event) => events.push(event), timeouts),
    events,
  };
}

const grant = (id: string) => ({ id });

Deno.test("share request: asking for a folder announces the reason and waits", async () => {
  const { hub: h, events } = hub();
  const before = Date.now();
  const waited = h.askLend("call-1", "read the exports", ["old"]);
  assertEquals(events.length, 1);
  const request = events[0]!;
  assertEquals(request.type, "share_request");
  if (request.type === "share_request") {
    assertEquals(request.sessionId, "s1");
    assertEquals(request.toolCallId, "call-1");
    assertEquals(request.kind, "lend");
    // The reason is the agent's own sentence: the card has nothing else that
    // says why a folder is wanted.
    assertEquals(
      request.kind === "lend" ? request.reason : "",
      "read the exports",
    );
    assertEquals(request.expiresAt >= before, true);
  }
  assertEquals(h.pendingShareRequest(), {
    kind: "lend",
    toolCallId: "call-1",
    reason: "read the exports",
    expiresAt: events[0]!.type === "share_request" ? events[0]!.expiresAt : 0,
  });

  h.finishLend("call-1");
  assertEquals(await waited, { kind: "lent" });
  const end = events.at(-1);
  assertEquals(end?.type, "share_request_end");
  if (end?.type === "share_request_end") assertEquals(end.outcome, "lent");
  assertEquals(h.pendingShareRequest(), null);
});

Deno.test("share request: a loan that was already there is not an answer", async () => {
  // The user's announcement also fires when an existing loan's terms change,
  // and that must not settle a request the user has not looked at: only a
  // grant that was not lent when the card appeared answers it.
  const { hub: h } = hub();
  const waited = h.askLend("call-1", "read the exports", ["old"]);
  h.settleFromGrants([grant("old")]);
  assertEquals(h.pendingShareRequest()?.toolCallId, "call-1");
  h.settleFromGrants([grant("old"), grant("new")]);
  assertEquals(await waited, { kind: "lent" });
  // A second announcement settles nothing (the wait is over).
  h.settleFromGrants([grant("old"), grant("new"), grant("newer")]);
  assertEquals(h.pendingShareRequest(), null);
});

Deno.test("share request: a refusal is an answer, not an error", async () => {
  const { hub: h, events } = hub();
  const waited = h.askLend("call-1", "read the exports", []);
  h.decline("call-1");
  assertEquals(await waited, { kind: "declined" });
  const end = events.at(-1);
  assertEquals(
    end?.type === "share_request_end" ? end.outcome : "",
    "declined",
  );
});

Deno.test("share request: nobody answering closes the card before the run moves on", async () => {
  const { hub: h, events } = hub({ lend: 5 });
  const waited = h.askLend("call-1", "read the exports", []);
  assertEquals(await waited, { kind: "timed_out" });
  // The card goes BEFORE the tool returns: a folder chosen afterwards has
  // nothing to answer, and a card left standing would look answerable.
  const end = events.at(-1);
  assertEquals(
    end?.type === "share_request_end" ? end.outcome : "",
    "timed_out",
  );
  assertEquals(events.length, 2);
});

Deno.test("share request: one question at a time", async () => {
  const { hub: h } = hub();
  const first = h.askLend("call-1", "read the exports", []);
  await assertRejects(
    () => h.askLend("call-2", "write the report", []),
    CoreError,
    "already being asked",
  );
  await assertRejects(
    () => h.askDisconnect("call-3", { id: "g1", name: "proj" }),
    CoreError,
    "already being asked",
  );
  h.finishLend("call-1");
  await first;
});

Deno.test("share request: a disconnect asks the app and ends with the loan", async () => {
  const { hub: h, events } = hub();
  const waited = h.askDisconnect("call-9", { id: "g1", name: "proj" });
  const request = events[0]!;
  assertEquals(request.type, "share_request");
  if (request.type === "share_request" && request.kind === "disconnect") {
    // The grant id is what the page hands to the shell; the name is for the
    // reader.
    assertEquals(request.id, "g1");
    assertEquals(request.name, "proj");
  } else {
    assert(false, "a disconnect was announced as something else");
  }
  assertEquals(h.pendingShareRequest()?.kind, "disconnect");

  h.finishDisconnect("call-9");
  assertEquals(await waited, { kind: "disconnected" });
});

Deno.test("share request: the app's reason reaches the tool as given", async () => {
  const { hub: h, events } = hub();
  const waited = h.askDisconnect("call-9", { id: "g1", name: "proj" });
  h.failDisconnect("call-9", "フォルダ共有のプロセスに接続できていません");
  assertEquals(await waited, {
    kind: "failed",
    error: "フォルダ共有のプロセスに接続できていません",
  });
  const end = events.at(-1);
  assertEquals(end?.type === "share_request_end" ? end.outcome : "", "failed");
});

Deno.test("share request: the loan vanishing settles a disconnect too", async () => {
  // The page forwards the request and posts what happened, but the server's
  // own list is the truth: a loan that is gone is a disconnect that worked.
  const { hub: h } = hub();
  const waited = h.askDisconnect("call-9", { id: "g1", name: "proj" });
  h.settleFromGrants([grant("g2")]);
  assertEquals(await waited, { kind: "disconnected" });
});

Deno.test("share request: an answer for the other question is refused", async () => {
  const { hub: h } = hub();
  const waited = h.askLend("call-1", "read the exports", []);
  // A card can only answer the question it shows: a disconnect answer while a
  // lend card stands is a stale request, not an outcome.
  assertEquals(
    (() => {
      try {
        h.finishDisconnect("call-1");
        return "settled";
      } catch (error) {
        return error instanceof CoreError ? error.kind : String(error);
      }
    })(),
    "not_found",
  );
  // And a tool call id that is not the waiting one is refused as well.
  assertEquals(
    (() => {
      try {
        h.finishLend("call-other");
        return "settled";
      } catch (error) {
        return error instanceof CoreError ? error.kind : String(error);
      }
    })(),
    "not_found",
  );
  h.finishLend("call-1");
  await waited;
});

Deno.test("share request: the run ending cancels the wait and closes the card", async () => {
  const { hub: h, events } = hub();
  const waited = h.askLend("call-1", "read the exports", []);
  h.cancelAll();
  await assertRejects(() => waited, CoreError);
  const end = events.at(-1);
  assertEquals(
    end?.type === "share_request_end" ? end.outcome : "",
    "declined",
  );
  assertEquals(h.pendingShareRequest(), null);
  // Idempotent: a second sweep has nothing left to close.
  h.cancelAll();
});

Deno.test("share request: a registry hands out one hub per session", () => {
  const events: ClientEvent[] = [];
  const registry = new ShareRequestRegistry((event) => events.push(event));
  const one = registry.for("s1");
  assertEquals(registry.for("s1"), one);
  // Reading a session that never asked must not create a hub: the snapshot
  // asks on every read.
  assertEquals(registry.get("s2"), undefined);
  assertEquals([...registry.sessionIds()], ["s1"]);
  registry.forget("s1");
  assertEquals(registry.get("s1"), undefined);
  assertEquals([...registry.sessionIds()], []);
});
