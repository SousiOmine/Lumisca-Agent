import { assert, assertEquals } from "@std/assert";
import { createShareProvider, shareSeedMessages } from "./context.ts";
import { shareRootOf } from "./grant.ts";
import { grantOf } from "./test-utils.ts";

/** A provider over a list the test changes between calls. */
function providerOf(grants: ReturnType<typeof grantOf>[]) {
  let current = grants;
  const provider = createShareProvider({ grants: () => current });
  return {
    provider,
    set(next: ReturnType<typeof grantOf>[]) {
      current = next;
    },
    /** The body of the next publication, or undefined when there is none. */
    body(): string | undefined {
      return provider.next()[0]?.body;
    },
  };
}

Deno.test("a conversation with nothing lent is told nothing", () => {
  const { provider } = providerOf([]);
  assertEquals(provider.next(), []);
});

Deno.test("a loan is announced with how to address it and what it allows", () => {
  const provider = providerOf([
    grantOf({
      name: "proj",
      write: true,
      exec: true,
      host: { platform: "macos", name: "mac", shell: "zsh" },
    }),
    grantOf({ id: "g2", name: "data", write: false, exec: false }),
  ]);
  const [update] = provider.provider.next();
  assert(update !== undefined);
  assertEquals(update.title, "Lent folders");
  // Every loan, with its own terms.
  assert(update.body.includes(`- ${shareRootOf("proj")} — read-write`));
  assert(update.body.includes("commands run there (zsh)"));
  assert(update.body.includes(`- ${shareRootOf("data")} — read-only`));
  assert(update.body.includes("no commands"));
  assert(update.body.includes("lent from"));
  // The rules the model has to follow, stated once.
  assert(update.body.includes("absolute path"));
  assert(update.body.includes("A command runs on that computer only"));
  assert(update.body.includes("can withdraw"));
  // The wording is the session's, not stella's: code mode has no machine.
  assert(!update.body.includes("machine"), update.body);
});

Deno.test("an unchanged list is not published twice", () => {
  const fixture = providerOf([grantOf()]);
  assert(fixture.body() !== undefined);
  assertEquals(fixture.provider.next(), []);
  // A new grant object with the same terms is the same loan.
  fixture.set([grantOf()]);
  assertEquals(fixture.provider.next(), []);
});

Deno.test("a changed loan republishes the whole list", () => {
  const fixture = providerOf([grantOf({ name: "proj" })]);
  fixture.body();
  // Writing taken away: the same folder, narrower terms.
  fixture.set([grantOf({ name: "proj", write: false })]);
  const [update] = fixture.provider.next();
  assert(update !== undefined);
  assert(update.body.includes("read-only"));
});

Deno.test("the last withdrawal is announced once, and then nothing", () => {
  const fixture = providerOf([grantOf()]);
  fixture.body();
  fixture.set([]);
  const [update] = fixture.provider.next();
  assert(update !== undefined);
  assert(update.body.includes("no longer available"));
  assert(update.body.includes("Nothing under /lend"));
  assertEquals(fixture.provider.next(), []);
  // …and a session that never lent anything never hears the ending either.
  const fresh = providerOf([]);
  assertEquals(fresh.provider.next(), []);
});

Deno.test("a rebase to the last publication does not repeat it", () => {
  const fixture = providerOf([grantOf()]);
  const [update] = fixture.provider.next();
  assert(update?.state !== undefined);
  const rebased = createShareProvider({ grants: () => [grantOf()] });
  rebased.rebase(update.state);
  assertEquals(rebased.next(), []);
  // A view that lost the publication (a compaction checkpoint before it)
  // publishes again.
  const forgotten = createShareProvider({ grants: () => [grantOf()] });
  forgotten.rebase(undefined);
  assertEquals(forgotten.next().length, 1);
});

Deno.test("a rebase onto the empty list still knows the loan ended", () => {
  // The state carried by the "no longer available" message is the empty
  // signature: nothing is lent, and there is nothing left to say.
  const provider = createShareProvider({ grants: () => [] });
  provider.rebase("");
  assertEquals(provider.next(), []);
});

Deno.test("a sub-agent is seeded with the loans of its session", () => {
  const provider = createShareProvider({
    grants: () => [grantOf({ name: "proj" })],
  });
  const messages = shareSeedMessages(provider, 1234);
  assertEquals(messages.length, 1);
  assertEquals(messages[0]?.role, "context");
  if (messages[0]?.role !== "context") throw new Error("unreachable");
  assertEquals(messages[0].provider, "shares");
  assertEquals(messages[0].timestamp, 1234);
  assert(messages[0].body.includes(shareRootOf("proj")));
});
