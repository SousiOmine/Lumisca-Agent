import { assertEquals, assertRejects } from "@std/assert";
import { EnvRequestHub } from "./env-request.ts";
import type { ClientEvent } from "../domain/event.ts";

/**
 * The environment-variable request: the wait, the events clients follow, and
 * the ways it ends. No machine is involved — the hub owns the promise, the
 * timer and the two events. Deadlines are exercised with a short `timeoutMs`
 * instead of waiting the real one.
 */

function hub(timeoutMs?: number): {
  hub: EnvRequestHub;
  events: ClientEvent[];
} {
  const events: ClientEvent[] = [];
  return {
    hub: new EnvRequestHub("s1", (event) => events.push(event), timeoutMs),
    events,
  };
}

Deno.test("env request: asking announces the variable and resolves when stored", async () => {
  const { hub: h, events } = hub();
  const before = Date.now();
  const waited = h.ask("call-1", "OPENAI_API_KEY", false);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.type, "env_request");
  if (events[0]!.type === "env_request") {
    assertEquals(events[0]!.name, "OPENAI_API_KEY");
    assertEquals(events[0]!.exists, false);
    // The deadline travels with the request: a client that reconnects
    // mid-wait reads it from the snapshot, and this is where it is set.
    assertEquals(events[0]!.expiresAt >= before, true);
    assertEquals(h.pendingEnvRequest()?.expiresAt, events[0]!.expiresAt);
  }
  assertEquals(h.pendingEnvRequest()?.toolCallId, "call-1");

  h.finish("call-1");
  // The outcome carries no value: the hub never receives one, so nothing
  // downstream (the tool result, the transcript) can.
  assertEquals(await waited, { kind: "set" });
  const end = events.at(-1);
  assertEquals(end?.type, "env_request_end");
  if (end?.type === "env_request_end") {
    assertEquals(end.outcome, "set");
  }
  assertEquals(h.pendingEnvRequest(), null);
});

Deno.test("env request: an existing name is announced as an overwrite", async () => {
  const { hub: h, events } = hub();
  const waited = h.ask("call-1", "GITHUB_TOKEN", true);
  assertEquals(
    events[0]!.type === "env_request" ? events[0]!.exists : undefined,
    true,
  );
  h.decline("call-1");
  assertEquals(await waited, { kind: "declined" });
});

Deno.test("env request: the deadline hands the run back without a value", async () => {
  const { hub: h, events } = hub(20);
  const waited = h.ask("call-1", "KEY", false);
  assertEquals(await waited, { kind: "timed_out" });
  // The dialog is closed BEFORE the run moves on: the user may be typing,
  // and a value arriving afterwards would have nowhere to go.
  const end = events.at(-1);
  assertEquals(end?.type, "env_request_end");
  if (end?.type === "env_request_end") {
    assertEquals(end.toolCallId, "call-1");
    assertEquals(end.outcome, "timed_out");
  }
  assertEquals(h.pendingEnvRequest(), null);

  // A late answer is refused rather than silently accepted.
  let message = "";
  try {
    h.finish("call-1");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("No environment variable"), true);
});

Deno.test("env request: a settled wait leaves no timer behind", async () => {
  // The deadline timer keeps running in the background; a leaked one would
  // fire later and close a request the user is still answering.
  const { hub: h, events } = hub(20);
  const first = h.ask("call-1", "KEY", false);
  h.decline("call-1");
  assertEquals(await first, { kind: "declined" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(events.filter((e) => e.type === "env_request_end").length, 1);
});

Deno.test("env request: only one at a time", async () => {
  const { hub: h } = hub();
  const first = h.ask("call-1", "ONE", false);
  await assertRejects(
    () => h.ask("call-2", "TWO", false),
    Error,
    "already being asked",
  );
  h.decline("call-1");
  await first;
});

Deno.test("env request: finishing when nothing waits is refused", () => {
  const { hub: h } = hub();
  let message = "";
  try {
    h.finish("nothing");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("No environment variable"), true);
});

Deno.test("env request: a mismatched tool call does not resolve the wait", async () => {
  const { hub: h } = hub();
  const waited = h.ask("call-1", "KEY", false);
  let message = "";
  try {
    h.finish("call-2");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("call-2"), true);
  assertEquals(h.pendingEnvRequest()?.toolCallId, "call-1");
  h.finish("call-1");
  await waited;
});

Deno.test("env request: cancelling rejects the wait and closes the dialog", async () => {
  const { hub: h, events } = hub();
  const waited = h.ask("call-1", "KEY", false);
  h.cancelAll();
  await assertRejects(() => waited, Error, "cancelled");
  assertEquals(h.pendingEnvRequest(), null);
  assertEquals(events.at(-1)?.type, "env_request_end");
  // Idempotent: the run's teardown may call it more than once.
  h.cancelAll();
});

Deno.test("env request: an already aborted signal never registers", async () => {
  const { hub: h, events } = hub();
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => h.ask("call-1", "KEY", false, controller.signal),
    Error,
  );
  assertEquals(h.pendingEnvRequest(), null);
  assertEquals(events.length, 0);
});

Deno.test("env request: aborting the run settles the wait", async () => {
  const { hub: h } = hub();
  const controller = new AbortController();
  const waited = h.ask("call-1", "KEY", false, controller.signal);
  controller.abort();
  await assertRejects(() => waited, Error);
  assertEquals(h.pendingEnvRequest(), null);
});
