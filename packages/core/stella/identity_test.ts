import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";
import { toolText } from "../test-utils.ts";
import { createStellaAgentRepo, MAX_AGENT_IDENTITY_CHARS } from "./agents.ts";
import { createIdentityTool, type IdentityTarget } from "./identity.ts";

/**
 * The identity: the text an agent writes about itself, and the tool that
 * reads and writes it.
 *
 * The text reaches the model through the system prompt, generated once per
 * open and refreshed only by a compaction. A write is stored at once but is
 * not visible in the prompt of the run that made it; these tests pin that
 * split and the tool's own contract.
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

test("identity tool: read says there is none yet, then returns the text", async () => {
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

test("identity tool: a write says when it takes effect and can clear the text", async () => {
  const target = memoryTarget("Old text.");
  const tool = createIdentityTool(target);

  const written = await tool.execute(
    "1",
    { action: "write", content: "New text." },
    undefined,
  );
  // The model must not assume its current system prompt carries the new
  // text: the prompt is fixed until the conversation is compacted or
  // reopened.
  assertStringIncludes(toolText(written), "compacted or reopened");

  const cleared = await tool.execute(
    "2",
    { action: "write", content: "" },
    undefined,
  );
  assertEquals(target.text, "");
  assertStringIncludes(toolText(cleared), "was cleared");
});

test("identity tool: edit changes one passage and keeps the rest", async () => {
  const target = memoryTarget(
    "How I speak: polite.\nThe user: Mio.\nMy hours: 9-18.",
  );
  const tool = createIdentityTool(target);

  const result = await tool.execute(
    "1",
    {
      action: "edit",
      old_string: "The user: Mio.",
      new_string: "The user: Mio (call her Mio, not Ms. Sato).",
    },
    undefined,
  );
  assertEquals(
    target.text,
    "How I speak: polite.\nThe user: Mio (call her Mio, not Ms. Sato).\n" +
      "My hours: 9-18.",
  );
  // A change takes effect when the prompt is next generated, exactly like a
  // write.
  assertStringIncludes(toolText(result), "compacted or reopened");
});

test("identity tool: edit refuses a missing or ambiguous match", async () => {
  const tool = createIdentityTool(memoryTarget("One. Two. Two."));

  let missing: unknown;
  try {
    await tool.execute(
      "1",
      { action: "edit", old_string: "Three.", new_string: "X" },
      undefined,
    );
  } catch (failure) {
    missing = failure;
  }
  assert(missing instanceof Error);
  assertStringIncludes(missing.message, "not found");

  // Ambiguity fails instead of changing the first of several matches: the
  // model then writes the rest of the note on top of the wrong passage.
  let ambiguous: unknown;
  try {
    await tool.execute(
      "1",
      { action: "edit", old_string: "Two.", new_string: "X" },
      undefined,
    );
  } catch (failure) {
    ambiguous = failure;
  }
  assert(ambiguous instanceof Error);
  assertStringIncludes(ambiguous.message, "appears 2 times");
});

test("identity tool: edit before a passage exists says what to do", async () => {
  const tool = createIdentityTool(memoryTarget());

  let missing: unknown;
  try {
    await tool.execute("1", { action: "edit", old_string: "a" }, undefined);
  } catch (failure) {
    missing = failure;
  }
  assert(missing instanceof Error);
  assertStringIncludes(missing.message, "needs old_string and new_string");

  let empty: unknown;
  try {
    await tool.execute(
      "2",
      { action: "edit", old_string: "a", new_string: "b" },
      undefined,
    );
  } catch (failure) {
    empty = failure;
  }
  assert(empty instanceof Error);
  assertStringIncludes(empty.message, "nothing to edit");
});

test("identity tool: an edit is held to the identity's length limit", async () => {
  const original = "x".repeat(10);
  const target = memoryTarget(original);
  const tool = createIdentityTool(target);

  let tooLong: unknown;
  try {
    await tool.execute(
      "1",
      {
        action: "edit",
        old_string: original,
        new_string: "x".repeat(MAX_AGENT_IDENTITY_CHARS + 1),
      },
      undefined,
    );
  } catch (failure) {
    tooLong = failure;
  }
  assert(tooLong instanceof CoreError);
  assertEquals(target.text, original);
});

test("identity tool: write without content, and unknown actions, explain themselves", async () => {
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
  assertStringIncludes(unknown.message, 'Use "read", "write" or "edit"');
});

test("identity: the repo target reads and writes the agent's row", async () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createStellaAgentRepo(db);
    const agent = repo.create({ name: "Aide", role: "Keep notes." });
    const target: IdentityTarget = {
      read: () => repo.get(agent.id)?.identity ?? "",
      write: (content) => repo.writeIdentity(agent.id, content),
    };

    assertEquals(target.read(), "");
    target.write("I keep the notes.");
    assertEquals(target.read(), "I keep the notes.");
    assertEquals(repo.get(agent.id)?.role, "Keep notes.");

    // A write through the tool lands on that same row, which is what the
    // next system-prompt generation reads.
    const tool = createIdentityTool(target);
    await tool.execute("1", { action: "write", content: "Second." }, undefined);
    assertEquals(target.read(), "Second.");
  } finally {
    db.close();
  }
});
