import { assert, assertEquals, assertRejects } from "@std/assert";
import { ShareHub, type ShareSink } from "./hub.ts";
import type { ShareServerFrame } from "./ops.ts";
import { grantOf } from "./test-utils.ts";

const host = { platform: "macos", name: "mac", shell: "zsh" } as const;

/** A connection that only records what the hub sends it. */
function sinkOf(): ShareSink & { frames: ShareServerFrame[] } {
  const frames: ShareServerFrame[] = [];
  return { frames, send: (frame) => frames.push(frame) };
}

Deno.test("grants are scoped to a session, sorted, and expire on their own", () => {
  const hub = new ShareHub();
  const sink = sinkOf();
  hub.register(sink, {
    clientId: "app-1",
    host,
    grants: [
      grantOf({ id: "b", name: "zebra", sessionId: "s1" }),
      grantOf({ id: "a", name: "alpha", sessionId: "s1" }),
      grantOf({ id: "c", name: "other", sessionId: "s2" }),
      grantOf({
        id: "d",
        name: "gone",
        sessionId: "s1",
        expiresAt: Date.now() - 1,
      }),
    ],
  });
  assertEquals(
    hub.grantsFor("s1").map((g) => g.name),
    ["alpha", "zebra"],
  );
  assertEquals(
    hub.grantsFor("s2").map((g) => g.name),
    ["other"],
  );
  assertEquals(hub.grantsFor("s3"), []);
  // The client's copy is the same list without the session it is keyed by.
  const shares = hub.sharesFor("s1");
  assertEquals(
    shares.map((s) => s.name),
    ["alpha", "zebra"],
  );
  assert(!("sessionId" in shares[0]!));
});

Deno.test("a call is one frame, and its answer settles it", async () => {
  const hub = new ShareHub();
  const sink = sinkOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grantOf()] });

  const pending = hub.call("g1", "stat", { path: ["a.txt"] });
  const frame = sink.frames[0];
  assertEquals(frame?.type, "op");
  if (frame?.type !== "op") throw new Error("expected an op frame");
  assertEquals(frame.grant, "g1");
  assertEquals(frame.call, { op: "stat", path: ["a.txt"] });

  hub.settle(sink, {
    type: "result",
    id: frame.id,
    ok: true,
    value: { isFile: true, size: 3 },
  });
  assertEquals(await pending, { isFile: true, size: 3 });
});

Deno.test("a failure from the lent computer is the call's rejection", async () => {
  const hub = new ShareHub();
  const sink = sinkOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grantOf()] });

  const pending = hub.call("g1", "readText", { path: [], maxBytes: 10 });
  const frame = sink.frames[0];
  if (frame?.type !== "op") throw new Error("expected an op frame");
  hub.settle(sink, {
    type: "result",
    id: frame.id,
    ok: false,
    error: "EACCES: permission denied",
  });
  await assertRejects(() => pending, Error, "EACCES");
});

Deno.test("an answer from a connection that no longer owns the call is ignored", async () => {
  const hub = new ShareHub();
  const first = sinkOf();
  const second = sinkOf();
  hub.register(first, { clientId: "app-1", host, grants: [grantOf()] });

  const pending = hub.call("g1", "stat", { path: [] });
  const frame = first.frames[0];
  if (frame?.type !== "op") throw new Error("expected an op frame");

  // The app reconnected before it answered: the old socket's result must not
  // settle a call the new connection is now responsible for.
  hub.register(second, { clientId: "app-1", host, grants: [grantOf()] });
  hub.settle(second, { type: "result", id: frame.id, ok: true, value: null });
  // …and the reconnect rejected the work the old socket owed.
  await assertRejects(() => pending, Error, "no longer connected");
});

Deno.test("a wedged computer is timed out, and told to stop", async () => {
  const hub = new ShareHub({ opTimeoutMs: 5 });
  const sink = sinkOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grantOf()] });

  const pending = hub.call("g1", "listDir", { path: [] });
  await assertRejects(() => pending, Error, "did not answer");
  const cancel = sink.frames[1];
  assertEquals(cancel?.type, "cancel");
});

Deno.test("an exec waits its own timeout, not the file timeout", async () => {
  const hub = new ShareHub({ opTimeoutMs: 1, execGraceMs: 10_000 });
  const sink = sinkOf();
  hub.register(sink, {
    clientId: "app-1",
    host,
    grants: [grantOf()],
  });

  const pending = hub.call("g1", "exec", {
    path: [],
    command: "sleep 1",
    timeoutSec: 1,
    maxOutputChars: 10,
  });
  const frame = sink.frames[0];
  if (frame?.type !== "op") throw new Error("expected an op frame");
  hub.settle(sink, {
    type: "result",
    id: frame.id,
    ok: true,
    value: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      timedOut: false,
      orphanedOutput: false,
    },
  });
  assertEquals((await pending).exitCode, 0);
});

Deno.test("stopping the run cancels the call on the other side", async () => {
  const hub = new ShareHub();
  const sink = sinkOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grantOf()] });

  const controller = new AbortController();
  const pending = hub.call("g1", "stat", { path: [] }, controller.signal);
  controller.abort();
  await assertRejects(() => pending, Error, "stopped");
  assertEquals(sink.frames[1]?.type, "cancel");
});

Deno.test("a folder stops answering the moment its app disconnects", async () => {
  const hub = new ShareHub();
  const sink = sinkOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grantOf()] });

  const pending = hub.call("g1", "stat", { path: [] });
  hub.disconnect(sink);
  await assertRejects(() => pending, Error, "no longer connected");
  assertEquals(hub.grantsFor("s1"), []);
  // The grant index is gone with it: a later call fails before any frame.
  await assertRejects(
    () => hub.call("g1", "stat", { path: [] }),
    Error,
    "no longer lent",
  );
});

Deno.test("changes are reported once per affected session", () => {
  const hub = new ShareHub();
  const changes: string[][] = [];
  hub.onSharesChange((sessions) => changes.push([...sessions]));
  const sink = sinkOf();
  hub.register(sink, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "a", sessionId: "s1" })],
  });
  hub.register(sink, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "a", sessionId: "s1", write: false })],
  });
  hub.register(sink, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "b", sessionId: "s2" })],
  });
  hub.disconnect(sink);
  assertEquals(changes, [["s1"], ["s1"], ["s1", "s2"], ["s2"]]);
});

Deno.test("an unchanged announcement adds no report", () => {
  const hub = new ShareHub();
  const changes: string[][] = [];
  hub.onSharesChange((sessions) => changes.push([...sessions]));
  const sink = sinkOf();
  // One grant object, announced twice: the expiries must match, or the
  // clock alone would look like a change.
  const grant = grantOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grant] });
  hub.register(sink, { clientId: "app-1", host, grants: [{ ...grant }] });
  assertEquals(changes, [["s1"]]);
});

Deno.test("closing the hub settles everything in flight", async () => {
  const hub = new ShareHub();
  const sink = sinkOf();
  hub.register(sink, { clientId: "app-1", host, grants: [grantOf()] });
  const pending = hub.call("g1", "stat", { path: [] });
  hub.close();
  await assertRejects(() => pending, Error, "shutting down");
  assertEquals(hub.grantsFor("s1"), []);
});
