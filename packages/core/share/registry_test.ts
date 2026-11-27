import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { isExpired } from "./grant.ts";
import type { ShareServerFrame } from "./ops.ts";
import { ShareRegistry, sharesOf } from "./registry.ts";
import { grantOf } from "./test-utils.ts";

/**
 * The registry on its own: what is lent, to which session, until when, and
 * the announcement that a name does not have to be unique for.
 *
 * The hub's tests cover the same ground through the object the app uses; these
 * pin the registry's half so a change to the broker cannot hide a change to
 * what a session may reach.
 */

const host = { platform: "macos", name: "mac", shell: "zsh" } as const;

function sinkOf(): { send(frame: ShareServerFrame): void } {
  return { send: () => {} };
}

test("a grant is expired at its deadline, not after it", () => {
  const grant = grantOf({ expiresAt: 1_000 });
  assertEquals(isExpired(grant, 999), false);
  assertEquals(isExpired(grant, 1_000), true);
  assertEquals(isExpired(grant, 1_001), true);
});

test("a grant without a deadline never expires", () => {
  // なし: the lender keeps the loan until it is disconnected, so the server
  // must not read "no deadline" as "expired long ago".
  const grant = grantOf({ expiresAt: null });
  assertEquals(isExpired(grant, Date.now()), false);
  assertEquals(isExpired(grant, Number.MAX_SAFE_INTEGER), false);
});

test("grantsFor drops the expired one and sorts the rest by name", () => {
  const registry = new ShareRegistry();
  registry.register(sinkOf(), {
    clientId: "app-1",
    host,
    grants: [
      grantOf({ id: "b", name: "zebra", sessionId: "s1" }),
      grantOf({ id: "a", name: "alpha", sessionId: "s1" }),
      grantOf({ id: "gone", name: "dead", sessionId: "s1", expiresAt: 5 }),
      grantOf({ id: "other", name: "elsewhere", sessionId: "s2" }),
    ],
  });
  assertEquals(
    registry.grantsFor("s1", 1_000).map((grant) => grant.name),
    ["alpha", "zebra"],
  );
  assertEquals(registry.grantsFor("s2", 1_000).length, 1);
  assertEquals(registry.grantsFor("s3", 1_000), []);
});

test("a name is made unique across connections of the same session", () => {
  const registry = new ShareRegistry();
  registry.register(sinkOf(), {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "a", name: "proj", sessionId: "s1" })],
  });
  // A second computer cannot see the first, so the server names its folder
  // around the one already there — and the conversation's paths stay unique.
  registry.register(sinkOf(), {
    clientId: "app-2",
    host,
    grants: [grantOf({ id: "b", name: "proj", sessionId: "s1" })],
  });
  assertEquals(
    registry.grantsFor("s1", 1_000).map((grant) => grant.name),
    ["proj", "proj-2"],
  );
});

test("a withdrawal is the absence of an id, and it is reported", () => {
  const registry = new ShareRegistry();
  const changes: string[][] = [];
  registry.onSharesChange((sessions) => changes.push([...sessions]));
  const sink = sinkOf();
  registry.register(sink, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "a", sessionId: "s1" })],
  });
  registry.register(sink, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "b", sessionId: "s2" })],
  });
  assertEquals(registry.grantsFor("s1", 1_000), []);
  assertEquals(changes, [["s1"], ["s1", "s2"]]);
});

test("a reconnect keeps the name the conversation already knows", () => {
  const registry = new ShareRegistry();
  const first = sinkOf();
  registry.register(first, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "a", name: "proj", sessionId: "s1" })],
  });
  const second = sinkOf();
  registry.register(second, {
    clientId: "app-1",
    host,
    grants: [grantOf({ id: "a", name: "proj", sessionId: "s1" })],
  });
  assertEquals(
    registry.grantsFor("s1", 1_000).map((grant) => grant.name),
    ["proj"],
  );
});

test("the client's copy drops the session the server keys the loan by", () => {
  const shares = sharesOf([grantOf({ sessionId: "s1" })]);
  assertEquals("sessionId" in shares[0]!, false);
});
