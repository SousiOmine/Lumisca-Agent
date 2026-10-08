import { assert, assertEquals } from "@std/assert";
import { createDateProvider, DATE_PROVIDER } from "./date-context.ts";
import { today } from "../environment.ts";

Deno.test("date context: publishes the current date once, then only on a new day", () => {
  let now = new Date("2026-10-08T12:00:00Z");
  const provider = createDateProvider({ now: () => now });
  assertEquals(provider.name, DATE_PROVIDER);

  const first = provider.next();
  assertEquals(first.length, 1);
  const update = first[0]!;
  assertEquals(update.title, `Date: ${today(now)}`);
  assertEquals(
    update.body,
    `The current date is ${today(now)}.`,
    "the first reading carries no replacement note",
  );
  assertEquals(update.state, { date: today(now) });

  // An unchanged date is not republished: the message is already in the
  // transcript and costs nothing more.
  assertEquals(provider.next(), []);

  now = new Date("2026-10-09T12:00:00Z");
  const next = provider.next();
  assertEquals(next.length, 1);
  assertEquals(next[0]!.title, `Date: ${today(now)}`);
  assertEquals(
    next[0]!.body.includes("replaces the earlier one"),
    true,
    "a changed date must say it supersedes the earlier reading",
  );
});

Deno.test("date context: rebase re-anchors to the last publication", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const provider = createDateProvider({ now: () => now });
  const published = provider.next()[0]!;

  // Reopening a session: the transcript already carries the reading, so the
  // provider must stay silent.
  provider.rebase(published.state);
  assertEquals(provider.next(), []);

  // A rewind removed it: the next check republishes.
  provider.rebase(undefined);
  assertEquals(provider.next().length, 1);

  // An unreadable state republishes too (a fresh baseline is harmless).
  provider.rebase("not a state");
  assertEquals(provider.next().length, 1);
});

Deno.test("date context: state is a date string, never the payload text", () => {
  const provider = createDateProvider({
    now: () => new Date("2026-10-08T12:00:00Z"),
  });
  const state = provider.next()[0]!.state as { date: string };
  assert(
    Object.keys(state).length === 1 && typeof state.date === "string",
    "the state must stay small: a long transcript pays for the body once",
  );
  assert(state.date.startsWith("2026-10-08"));
});
