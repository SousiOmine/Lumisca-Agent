import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createIdentityProvider,
  createIdentityTool,
  IDENTITY_PROVIDER,
  type IdentityTarget,
} from "./identity.ts";
import { MAX_AGENT_IDENTITY_CHARS } from "./agents.ts";
import { CoreError } from "../errors.ts";
import { createAgentRepo } from "./agents.ts";
import { LumiscaDb } from "../db/mod.ts";
import { toolText } from "../test-utils.ts";

/**
 * The identity: the text an agent writes about itself, and how it reaches the
 * model.
 *
 * The point of these tests is the split the design turns on — the text is
 * published as a context message (so the snapshotted system prompt never has
 * to change), and a write is visible from the next publication, not from the
 * run that made it.
 */

/** An in-memory target, optionally with a recording write. */
function memoryTarget(initial = ""): IdentityTarget & { text: string } {
  const target = {
    text: initial,
    read: () => target.text,
    write: (content: string) => {
      const text = content.trim();
      if (text.length > MAX_AGENT_IDENTITY_CHARS) {
        throw new CoreError("too long", "invalid");
      }
      target.text = text;
    },
  };
  return target;
}

/** The published body of an update, flattened for assertions. */
function bodies(updates: Array<{ body: string }>): string {
  return updates.map((update) => update.body).join("\n\n");
}

Deno.test("identity tool: read says there is none yet, then returns the text", async () => {
  const target = memoryTarget();
  const tool = createIdentityTool(target);

  const empty = await tool.execute("1", { action: "read" }, undefined);
  assertStringIncludes(toolText(empty), "have not written an identity");

  await tool.execute(
    "1",
    { action: "write", content: "I keep notes." },
    undefined,
  );
  const read = await tool.execute("2", { action: "read" }, undefined);
  assertStringIncludes(
    toolText(read),
    "<identity>\nI keep notes.\n</identity>",
  );
  assertEquals(target.text, "I keep notes.");
});

Deno.test("identity tool: a write says when it takes effect and can clear the text", async () => {
  const target = memoryTarget("Old text.");
  const tool = createIdentityTool(target);

  const written = await tool.execute(
    "1",
    { action: "write", content: "New text." },
    undefined,
  );
  // The model must not assume its current run already carries the new text.
  assertStringIncludes(toolText(written), "next turn");

  const cleared = await tool.execute(
    "2",
    { action: "write", content: "" },
    undefined,
  );
  assertEquals(target.text, "");
  assertStringIncludes(toolText(cleared), "was cleared");
});

Deno.test("identity tool: write without content, and unknown actions, explain themselves", async () => {
  const tool = createIdentityTool(memoryTarget());
  let missing: unknown;
  try {
    await tool.execute("1", { action: "write" }, undefined);
  } catch (failure) {
    missing = failure;
  }
  assert(missing instanceof Error);
  assertStringIncludes(missing.message, "needs content");

  let unknown: unknown;
  try {
    await tool.execute("2", { action: "forget" }, undefined);
  } catch (failure) {
    unknown = failure;
  }
  assert(unknown instanceof Error);
  assertStringIncludes(unknown.message, 'Use "read" or "write"');
});

Deno.test("identity provider: publishes the agent's text once, and only on change", () => {
  const target = memoryTarget();
  const provider = createIdentityProvider(target);

  // Nothing written → nothing to say (a first turn must not open with an
  // empty identity block).
  assertEquals(provider.next(), []);

  target.write("I keep notes.");
  const first = provider.next();
  assertEquals(first.length, 1);
  assertEquals(first[0]!.title, "Identity (written by you)");
  assertStringIncludes(
    first[0]!.body,
    "<identity>\nI keep notes.\n</identity>",
  );
  // The state carries a hash, not the text: the transcript must not pay for
  // the same note twice.
  assertEquals(typeof (first[0]!.state as { hash: string }).hash, "string");
  assertEquals("text" in (first[0]!.state as Record<string, unknown>), false);

  // Unchanged → quiet.
  assertEquals(provider.next(), []);

  target.write("I keep notes and check facts.");
  const update = provider.next();
  assertEquals(update.length, 1);
  // A later publication says it replaces the earlier one, so a stale copy
  // in the transcript cannot be mistaken for the current text.
  assertStringIncludes(bodies(update), "replaces the earlier one");
  assertStringIncludes(bodies(update), "I keep notes and check facts.");
});

Deno.test("identity provider: clearing the text is announced once", () => {
  const target = memoryTarget("I keep notes.");
  const provider = createIdentityProvider(target);
  provider.next();

  target.write("");
  const cleared = provider.next();
  assertEquals(cleared.length, 1);
  assertEquals(cleared[0]!.title, "Identity (cleared)");
  // And not again: the model has been told.
  assertEquals(provider.next(), []);

  // Reopening rebases onto that message, so the notice is not repeated for
  // the whole life of the conversation.
  provider.rebase(cleared[0]!.state);
  assertEquals(provider.next(), []);
  assertEquals(target.text, "");
});

Deno.test("identity provider: writing again after a clear is a fresh statement", () => {
  const target = memoryTarget("First.");
  const provider = createIdentityProvider(target);
  provider.next();
  target.write("");
  provider.next();

  target.write("Second.");
  const again = provider.next();
  assertEquals(again.length, 1);
  // Nothing is being replaced: the transcript's last identity message said
  // the text was cleared.
  assertEquals(again[0]!.body.includes("replaces the earlier one"), false);
  assertStringIncludes(again[0]!.body, "<identity>\nSecond.\n</identity>");
});

Deno.test("identity provider: a rebased session republishes only what it lost", () => {
  const target = memoryTarget();
  const provider = createIdentityProvider(target);
  assertEquals(provider.name, IDENTITY_PROVIDER);

  target.write("I keep notes.");
  const published = provider.next()[0]!;

  // Reopening restores the state from the transcript: nothing to publish.
  provider.rebase(published.state);
  assertEquals(provider.next(), []);

  // A rewind that dropped the message leaves no state: the current text is
  // published again, framed as a fresh statement (not as a replacement).
  provider.rebase(undefined);
  const again = provider.next();
  assertEquals(again.length, 1);
  assertEquals(again[0]!.body.includes("replaces the earlier one"), false);
});

Deno.test("identity: the repo target reads and writes the agent's row", async () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createAgentRepo(db);
    const agent = repo.create({ name: "Aide", role: "Keep notes." });
    const target: IdentityTarget = {
      read: () => repo.get(agent.id)?.identity ?? "",
      write: (content) => repo.writeIdentity(agent.id, content),
    };

    assertEquals(target.read(), "");
    target.write("I keep the notes.");
    assertEquals(target.read(), "I keep the notes.");
    assertEquals(repo.get(agent.id)?.role, "Keep notes.");

    // The tool and the provider share one row, so a write through the tool is
    // what the provider publishes.
    const provider = createIdentityProvider(target);
    const tool = createIdentityTool(target);
    await tool.execute("1", { action: "write", content: "Second." }, undefined);
    assertStringIncludes(bodies(provider.next()), "Second.");
  } finally {
    db.close();
  }
});
