import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentRepo,
  DEFAULT_AGENT_NAME,
  MAX_AGENT_IDENTITY_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_ROLE_CHARS,
  normalizeAgentInput,
  type StellaAgent,
} from "./agents.ts";
import { createAgentCreateTool } from "./tools.ts";
import { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";
import { HostFileBackend } from "../tools/host/files.ts";
import { Sandbox } from "../workspace/sandbox.ts";

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

Deno.test("agents: a touch inside the creation millisecond still wins", () => {
  const { db, repo } = setup();
  try {
    // The clock is what makes this flaky in practice: two inserts and the
    // touch all land on the same `Date.now()` often enough that a plain
    // `updated_at = now` left the order to SQLite's row order. Freezing the
    // clock here forces that case every run.
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const first = repo.create({ name: "First", role: "r" });
      repo.create({ name: "Second", role: "r" });
      repo.touch(first.id);
    } finally {
      Date.now = realNow;
    }
    assertEquals(repo.latest()?.name, "First");
    assertEquals(repo.list().map((a) => a.name), ["First", "Second"]);
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

Deno.test("agents: a blank name becomes the default, a blank role stays blank", () => {
  // Creating an agent must not be blocked on two free-text answers: the
  // sidebar row needs a name, so an empty one gets the default label, and an
  // empty role simply means "no persona" (the app's own instructions).
  const { db, repo } = setup();
  try {
    const unnamed = repo.create({ name: "   ", role: "r" });
    assertEquals(unnamed.name, DEFAULT_AGENT_NAME);
    assertEquals(unnamed.role, "r");

    const roleless = repo.create({ name: "n", role: "  " });
    assertEquals(roleless.name, "n");
    assertEquals(roleless.role, "");

    assertEquals(repo.list().length, 2);
  } finally {
    db.close();
  }
});

Deno.test("agents: only an over-long name or role is refused", () => {
  const { db, repo } = setup();
  try {
    assertThrows(
      () =>
        repo.create({ name: "  ", role: "x".repeat(MAX_AGENT_ROLE_CHARS + 1) }),
      Error,
      "must be at most",
    );
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

Deno.test("agents: a long role is accepted — the limit is a brief, not a label", () => {
  const { db, repo } = setup();
  try {
    // A role is the agent's system prompt. 20,000 characters is a full brief
    // (job, tone, what to check, when to ask), and it has to survive the round
    // trip intact: truncated on write means an agent that quietly works from
    // half its instructions.
    const role = "x".repeat(MAX_AGENT_ROLE_CHARS);
    const created = repo.create({ name: "Long", role });
    assertEquals(created.role, role);
    assertEquals(repo.get(created.id)?.role, role);
    assertEquals(created.role.length, 20_000);
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
    repo.update(agent.id, { name: "New" });
    assertEquals(repo.get(agent.id)?.name, "New");
    assertThrows(
      () => repo.update(agent.id, { name: "  " }),
      Error,
      "must not be empty",
    );
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

Deno.test("agents: the icon starts empty and records a store-generated name", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Aide", role: "r" });
    // No picture yet: the client draws the initial instead, so the default
    // is "" rather than a name that would have to point at a file.
    assertEquals(agent.icon, "");
    assertEquals(repo.get(agent.id)?.icon, "");

    repo.update(agent.id, { icon: "9f3c2a1b4d5e.png" });
    assertEquals(repo.get(agent.id)?.icon, "9f3c2a1b4d5e.png");
    // Back to the initial.
    repo.update(agent.id, { icon: "" });
    assertEquals(repo.get(agent.id)?.icon, "");
  } finally {
    db.close();
  }
});

Deno.test("agents: a display change does not reorder the sidebar", () => {
  const { db, repo } = setup();
  try {
    const first = repo.create({ name: "First", role: "r" });
    repo.create({ name: "Second", role: "r" });
    // The most recently created is the default.
    assertEquals(repo.latest()?.name, "Second");
    // `updated_at` orders "who was talked to last"; picking a picture or
    // renaming an agent is not talking to it. If either moved the row, the
    // agent a fresh screen opens would follow the last cosmetic edit.
    repo.update(first.id, { icon: "9f3c2a1b4d5e.png" });
    assertEquals(repo.latest()?.name, "Second");
    repo.update(first.id, { name: "Renamed" });
    assertEquals(repo.latest()?.name, "Second");
    assertEquals(repo.get(first.id)?.name, "Renamed");
    assertEquals(repo.get(first.id)?.icon, "9f3c2a1b4d5e.png");
  } finally {
    db.close();
  }
});

Deno.test("agents: name and icon travel in one write", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Old", role: "r" });
    repo.update(agent.id, { name: "New", icon: "9f3c2a1b4d5e.png" });
    const updated = repo.get(agent.id);
    assertEquals(updated?.name, "New");
    assertEquals(updated?.icon, "9f3c2a1b4d5e.png");
    // A patch that names one field leaves the other alone.
    repo.update(agent.id, { name: "Newer" });
    assertEquals(repo.get(agent.id)?.icon, "9f3c2a1b4d5e.png");
    repo.update(agent.id, { icon: "" });
    assertEquals(repo.get(agent.id)?.name, "Newer");
  } finally {
    db.close();
  }
});

Deno.test("agents: the model starts unset and is set, kept and cleared", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Aide", role: "r" });
    // Unset is the app's default model, not a missing value to fill in.
    assertEquals(agent.model, null);
    repo.update(agent.id, { model: { provider: "faux", modelId: "large" } });
    assertEquals(repo.get(agent.id)?.model, {
      provider: "faux",
      modelId: "large",
    });
    // A patch that names only the name (or only the picture) leaves the
    // model alone: the dialog saves what changed.
    repo.update(agent.id, { name: "Renamed" });
    assertEquals(repo.get(agent.id)?.model?.modelId, "large");
    // null returns the agent to the default, which is a state the row can
    // hold — the columns go back to NULL, not to "" / "".
    repo.update(agent.id, { model: null });
    assertEquals(repo.get(agent.id)?.model, null);
  } finally {
    db.close();
  }
});

Deno.test("agents: a half-written model is refused", () => {
  // A pair with one empty half describes a request, not a model: storing it
  // would leave the conversation unable to open.
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Aide", role: "r" });
    assertThrows(
      () =>
        repo.update(agent.id, { model: { provider: "faux", modelId: "  " } }),
      Error,
      "both a provider and a model id",
    );
    assertEquals(repo.get(agent.id)?.model, null);
  } finally {
    db.close();
  }
});

Deno.test("agents: a renamed agent is trimmed and length-checked", () => {
  const { db, repo } = setup();
  try {
    const agent = repo.create({ name: "Old", role: "r" });
    // Trimmed like creation, so a stray newline never reaches the sidebar.
    repo.update(agent.id, { name: "  Padded  " });
    assertEquals(repo.get(agent.id)?.name, "Padded");
    // Over-long is refused rather than truncated, and the row keeps the name
    // it had.
    assertThrows(
      () =>
        repo.update(agent.id, { name: "x".repeat(MAX_AGENT_NAME_CHARS + 1) }),
      Error,
      "at most",
    );
    assertEquals(repo.get(agent.id)?.name, "Padded");
  } finally {
    db.close();
  }
});

Deno.test("agents: a patch for a missing agent fails instead of being lost", () => {
  const { db, repo } = setup();
  try {
    const error = assertThrows(
      () => repo.update("gone", { icon: "9f3c2a1b4d5e.png" }),
      CoreError,
    );
    assertEquals(error.kind, "not_found");
  } finally {
    db.close();
  }
});

// --- the creation tool ------------------------------------------------------

/** A creation tool over a real file backend: `files` are written into its
 * root, so a `role_file` goes through the same resolve → stat → read path
 * the tool uses in a session, and every agent it creates is recorded. */
async function agentToolFixture(
  options: {
    files?: Record<string, string | Uint8Array>;
    /** Replaces the core's create, for the tests about its own rules. */
    create?: (input: { name: string; role: string }) => Promise<StellaAgent>;
  } = {},
): Promise<{
  tool: ReturnType<typeof createAgentCreateTool>;
  created: Array<{ name: string; role: string }>;
  path: (name: string) => string;
  cleanup: () => Promise<void>;
}> {
  // Realpath'd: the sandbox resolves its roots through realpath (which is
  // what makes a symlinked or 8.3-short temp path — Windows `RUNNER~1`,
  // macOS `/var` → `/private/var` — compare equal to the path a tool
  // reports), so `path()` must hand out the same canonical form.
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-agent-create-" }),
  );
  for (const [name, data] of Object.entries(options.files ?? {})) {
    if (typeof data === "string") {
      await Deno.writeTextFile(join(root, name), data);
    } else {
      await Deno.writeFile(join(root, name), data);
    }
  }
  const created: Array<{ name: string; role: string }> = [];
  const tool = createAgentCreateTool({
    files: new HostFileBackend(new Sandbox([root])),
    create: options.create ?? ((input) => {
      created.push(input);
      return Promise.resolve({
        id: `a${created.length}`,
        name: input.name,
        role: input.role,
        identity: "",
        icon: "",
        model: null,
        onboardedAt: null,
        createdAt: 0,
        updatedAt: 0,
      });
    }),
  });
  return {
    tool,
    created,
    path: (name) => join(root, name),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("agent_create: creates through the core's own entry point", async () => {
  const test = await agentToolFixture();
  try {
    const result = await test.tool.execute(
      "1",
      { name: "Researcher", role: "Read papers and summarize." },
      undefined,
    );
    assertEquals(test.created, [{
      name: "Researcher",
      role: "Read papers and summarize.",
    }]);
    const text = result.content[0];
    assert(text?.type === "text");
    assert(text.text.includes('"Researcher"'), text.text);
    // The tool says what the user must do next: the sidebar, not this
    // conversation.
    assert(text.text.includes("sidebar"), text.text);
  } finally {
    await test.cleanup();
  }
});

Deno.test("agent_create: the role is read from a file in the machine", async () => {
  const brief = "# Researcher\n\nRead papers and summarize them.\n";
  const test = await agentToolFixture({ files: { "brief.md": brief } });
  try {
    const result = await test.tool.execute(
      "1",
      { name: "Researcher", role_file: test.path("brief.md") },
      undefined,
    );
    // The file's text is what the core receives: the model never has to
    // write the brief out again.
    assertEquals(test.created, [{ name: "Researcher", role: brief }]);
    const text = result.content[0];
    assert(text?.type === "text");
    // The result names the file that was read (the role itself is stored on
    // the agent; the file is not kept anywhere).
    assert(text.text.includes(test.path("brief.md")), text.text);
  } finally {
    await test.cleanup();
  }
});

Deno.test("agent_create: role and role_file are alternatives, not a pair", async () => {
  const test = await agentToolFixture({
    files: { "role.md": "From the file." },
  });
  try {
    const both = await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "Both", role: "Inline.", role_file: test.path("role.md") },
          undefined,
        ),
      CoreError,
    );
    assertEquals(both.kind, "invalid");
    const neither = await assertRejects(
      () => test.tool.execute("1", { name: "Neither" }, undefined),
      CoreError,
    );
    assertEquals(neither.kind, "invalid");
    // Neither attempt created an agent.
    assertEquals(test.created, []);
    // A model fills a field it chose not to use with null. That is "not
    // sent": the file is used, and the null does not become the role.
    const nulled = await test.tool.execute(
      "1",
      { name: "Nulled", role: null, role_file: test.path("role.md") } as never,
      undefined,
    );
    assertEquals(test.created, [{ name: "Nulled", role: "From the file." }]);
    const text = nulled.content[0];
    assert(text?.type === "text");
    // A null alone is still nothing to create from.
    const onlyNull = await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "Nulled", role: null } as never,
          undefined,
        ),
      CoreError,
    );
    assertEquals(onlyNull.kind, "invalid");
  } finally {
    await test.cleanup();
  }
});

Deno.test("agent_create: a role file that cannot be used is refused", async () => {
  const test = await agentToolFixture({
    files: {
      // Whitespace is not a role: the file was meant to hold instructions.
      "empty.md": " \n\t\n",
      // "Grüße" in Latin-1: not UTF-8, and a lenient decode would store
      // mojibake as the agent's instructions.
      "latin1.md": new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]),
      "huge.md": "x".repeat(MAX_AGENT_ROLE_CHARS * 4 + 1),
    },
  });
  try {
    const missing = await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "A", role_file: test.path("gone.md") },
          undefined,
        ),
      CoreError,
      "gone.md",
    );
    assertEquals(missing.kind, "not_found");
    await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "A", role_file: test.path(".") },
          undefined,
        ),
      CoreError,
      "directory",
    );
    await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "A", role_file: test.path("empty.md") },
          undefined,
        ),
      CoreError,
      "empty",
    );
    await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "A", role_file: test.path("latin1.md") },
          undefined,
        ),
      CoreError,
      "UTF-8",
    );
    // Over the byte bound: refused before it is transferred, and the
    // character limit is what the message names.
    await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "A", role_file: test.path("huge.md") },
          undefined,
        ),
      CoreError,
      "characters",
    );
    assertEquals(test.created, []);
  } finally {
    await test.cleanup();
  }
});

Deno.test("agent_create: a role file is held to the same character limit", async () => {
  const test = await agentToolFixture({
    files: { "long.md": "x".repeat(MAX_AGENT_ROLE_CHARS + 1) },
    // The core's own validation: the tool keeps no second copy of the limit,
    // so a file cannot slip past the rule an inline role obeys.
    create: (input) => {
      normalizeAgentInput(input);
      throw new Error("an over-long role must not reach the row");
    },
  });
  try {
    await assertRejects(
      () =>
        test.tool.execute(
          "1",
          { name: "Long", role_file: test.path("long.md") },
          undefined,
        ),
      CoreError,
      "at most",
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("agent_create: a taken name surfaces the core's conflict", async () => {
  const test = await agentToolFixture({
    create: () => {
      throw new CoreError(
        'An agent named "Aide" already exists. Choose another name.',
        "conflict",
      );
    },
  });
  try {
    const error = await assertRejects(
      () => test.tool.execute("1", { name: "Aide", role: "r" }, undefined),
      CoreError,
    );
    assertEquals(error.kind, "conflict");
  } finally {
    await test.cleanup();
  }
});
