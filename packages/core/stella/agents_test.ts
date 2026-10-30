import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createAgentRepo,
  MAX_AGENT_IDENTITY_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_ROLE_CHARS,
  normalizeAgentInput,
} from "./agents.ts";
import { createAgentCreateTool } from "./tools.ts";
import { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";

/**
 * stella's agents: the counterparts a user talks to.
 *
 * These cover the rules the rest of the app relies on and nothing else — an
 * agent is a name and a role, its conversation is one row pointing at it, and
 * a name that is taken is refused — because the conversation itself is an
 * ordinary session, tested where sessions are.
 */

function setup() {
  const db = LumiscaDb.openInMemory();
  const repo = createAgentRepo(db);
  return { db, repo };
}

Deno.test("agents: create, list and read back", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Aide", role: "Keep notes." });
    assertEquals(repo.get(agent.id)?.name, "Aide");
    assertEquals(repo.get(agent.id)?.role, "Keep notes.");
    assertEquals(repo.list().length, 1);
    // Trimmed on the way in, so a stray newline never reaches the prompt.
    const padded = repo.create({ name: "  Other  ", role: "  Do things.  " });
    assertEquals(padded.name, "Other");
    assertEquals(padded.role, "Do things.");
  } finally {
    db.close();
  }
});

Deno.test("agents: the most recently used one is the default", () => {
  const { db, repo } = setup();
  try {
    assertEquals(repo.latest(), undefined);
    const first = repo.create({ name: "First", role: "r" });
    repo.create({ name: "Second", role: "r" });
    // Creation order alone would make "Second" the default; touching the
    // first one is what the conversation does when the user returns to it.
    repo.touch(first.id);
    assertEquals(repo.latest()?.name, "First");
    // The list follows the same order.
    assertEquals(repo.list()[0]?.name, "First");
  } finally {
    db.close();
  }
});

Deno.test("agents: a blank name or role is refused with a sentence", () => {
  const { db, repo } = setup();
  try {
    assertThrows(
      () => repo.create({ name: "   ", role: "r" }),
      Error,
      "must not be empty",
    );
    assertThrows(
      () => repo.create({ name: "n", role: "  " }),
      Error,
      "role must not be empty",
    );
    assertEquals(repo.list(), []);
  } finally {
    db.close();
  }
});

Deno.test("agents: an over-long name or role is refused, never truncated", () => {
  const { db, repo } = setup();
  try {
    assertThrows(
      () =>
        repo.create({ name: "x".repeat(MAX_AGENT_NAME_CHARS + 1), role: "r" }),
      Error,
      "at most",
    );
    assertThrows(
      () =>
        repo.create({ name: "n", role: "x".repeat(MAX_AGENT_ROLE_CHARS + 1) }),
      Error,
      "at most",
    );
  } finally {
    db.close();
  }
});

Deno.test("agents: normalizeAgentInput trims both fields", () => {
  assertEquals(normalizeAgentInput({ name: " A ", role: " B " }), {
    name: "A",
    role: "B",
  });
});

Deno.test("agents: rename and delete", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Old", role: "r" });
    repo.rename(agent.id, "New");
    assertEquals(repo.get(agent.id)?.name, "New");
    assertThrows(() => repo.rename(agent.id, "  "), Error, "must not be empty");
    repo.delete(agent.id);
    assertEquals(repo.get(agent.id), undefined);
    assertEquals(repo.list(), []);
  } finally {
    db.close();
  }
});

Deno.test("agents: the identity is the agent's own text, kept apart from the role", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Aide", role: "Keep notes." });
    // Empty until written: the role is the user's, not the agent's.
    assertEquals(agent.identity, "");
    assertEquals(repo.get(agent.id)?.identity, "");

    repo.writeIdentity(agent.id, "  I take care of the notes.  ");
    // Trimmed, and the user's role is untouched.
    assertEquals(repo.get(agent.id)?.identity, "I take care of the notes.");
    assertEquals(repo.get(agent.id)?.role, "Keep notes.");

    // An empty string clears it (the tool's documented way to remove one).
    repo.writeIdentity(agent.id, "");
    assertEquals(repo.get(agent.id)?.identity, "");
  } finally {
    db.close();
  }
});

Deno.test("agents: an over-long identity is refused, never truncated", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Aide", role: "r" });
    const error = assertThrows(
      () =>
        repo.writeIdentity(agent.id, "x".repeat(MAX_AGENT_IDENTITY_CHARS + 1)),
      CoreError,
    );
    assertEquals(error.kind, "invalid");
    // The stored text is unchanged (nothing was written).
    assertEquals(repo.get(agent.id)?.identity, "");
  } finally {
    db.close();
  }
});

Deno.test("agents: an identity write for a missing agent fails", () => {
  const { db, repo } = setup();
  try {
    const error = assertThrows(
      () => repo.writeIdentity("gone", "text"),
      CoreError,
    );
    assertEquals(error.kind, "not_found");
  } finally {
    db.close();
  }
});

// --- the creation tool ------------------------------------------------------

Deno.test("agent_create: creates through the core's own entry point", async () => {
  const created: Array<{ name: string; role: string }> = [];
  const tool = createAgentCreateTool({
    create: (input) => {
      created.push(input);
      return {
        id: "a1",
        name: input.name,
        role: input.role,
        identity: "",
        createdAt: 0,
        updatedAt: 0,
      };
    },
  });
  const result = await tool.execute(
    "1",
    { name: "Researcher", role: "Read papers and summarize." },
    undefined,
  );
  assertEquals(created, [{
    name: "Researcher",
    role: "Read papers and summarize.",
  }]);
  const text = result.content[0];
  assert(text?.type === "text");
  assert(text.text.includes('"Researcher"'), text.text);
  // The tool says what the user must do next: the sidebar, not this
  // conversation.
  assert(text.text.includes("sidebar"), text.text);
});

Deno.test("agent_create: a taken name surfaces the core's conflict", async () => {
  const tool = createAgentCreateTool({
    create: () => {
      throw new CoreError(
        'An agent named "Aide" already exists. Choose another name.',
        "conflict",
      );
    },
  });
  let error: unknown;
  try {
    await tool.execute("1", { name: "Aide", role: "r" }, undefined);
  } catch (failure) {
    error = failure;
  }
  assert(error instanceof CoreError, String(error));
  assertEquals(error.kind, "conflict");
});
