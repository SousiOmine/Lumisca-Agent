import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createAgentRepo } from "../stella/agents.ts";
import { createWorkspaceRepo } from "../workspace/repo.ts";
import { createSessionRepo } from "./repo.ts";

/** A stella conversation has no name of its own.
 *
 * The row's `name` column is empty and every read joins the agent's name, so
 * a rename needs no write to the conversation and no read can answer with the
 * old name. Before this, the row kept a copy that was rewritten on the next
 * open — a stale window the notifications and the header could fall into.
 */
Deno.test("session repo: a stella conversation is named by its agent", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const workspace = createWorkspaceRepo(db).create("W", []);
    const agents = createAgentRepo(db);
    const agent = agents.create({ name: "Aide", role: "" });
    const sessions = createSessionRepo(db);
    const session = sessions.create({
      workspaceId: workspace.id,
      name: "",
      modelProvider: "faux",
      modelId: "faux",
      stella: true,
      agentId: agent.id,
    });

    // `create` answers with a read, so what a caller gets back is what every
    // other read would give.
    assertEquals(session.name, "Aide");

    agents.update(agent.id, { name: "Aide 2" });
    assertEquals(sessions.get(session.id)?.name, "Aide 2");
    assertEquals(sessions.getByAgent(agent.id)?.name, "Aide 2");

    // The row keeps no copy that could disagree with the agent.
    const row = db.db
      .prepare("SELECT name FROM sessions WHERE id = ?")
      .get(session.id) as { name: string };
    assertEquals(row.name, "");
  } finally {
    db.close();
  }
});

/** A stella conversation is still a session row: the lists exclude it, but a
 * read by id finds it, and a session with no agent keeps its own name. */
Deno.test("session repo: only an agent's conversation borrows its name", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const workspace = createWorkspaceRepo(db).create("W", []);
    const agents = createAgentRepo(db);
    const agent = agents.create({ name: "Aide", role: "" });
    const sessions = createSessionRepo(db);
    const conversation = sessions.create({
      workspaceId: workspace.id,
      name: "",
      modelProvider: "faux",
      modelId: "faux",
      stella: true,
      agentId: agent.id,
    });
    const ordinary = sessions.create({
      workspaceId: workspace.id,
      name: "Build failed",
      modelProvider: "faux",
      modelId: "faux",
    });

    assertEquals(ordinary.name, "Build failed");
    assertEquals(
      sessions.list().map((session) => session.id),
      [ordinary.id],
    );
    assertEquals(sessions.get(conversation.id)?.stella, true);
    assertEquals(sessions.get(conversation.id)?.agentId, agent.id);
    assertEquals(sessions.get(ordinary.id)?.stella, undefined);
  } finally {
    db.close();
  }
});
