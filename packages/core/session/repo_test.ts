import { assertEquals } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createSessionRepo, type SessionRepo } from "./repo.ts";

/** Insert the workspace row the sessions FK needs. */
function createWorkspace(db: LumiscaDb): void {
  db.db.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'test', 0)",
  ).run();
}

/** Workspace + session "s1", the row the goal assertions update. Both
 * timestamps start at 0 so a goal write's updated_at bump is visible. */
function seedSession(db: LumiscaDb, repo: SessionRepo): void {
  createWorkspace(db);
  repo.create({
    id: "s1",
    workspaceId: "ws1",
    name: "test",
    modelProvider: "faux",
    modelId: "model",
    createdAt: 0,
    updatedAt: 0,
  });
}

/** `lastReason` is omitted (not set to undefined) when there is none, so
 * the assertions below check the key rather than a falsy value. */
function hasLastReason(goal: { lastReason?: string } | undefined): boolean {
  return Object.hasOwn(goal ?? {}, "lastReason");
}

Deno.test("goal: setGoal round-trips the text, cap and initial progress", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);

    // The text as it arrives from the `/goal` declaration: multi line and
    // non-ASCII, so a mangled column or encoding would show up here.
    const text = "全テストを通す\n「deno task test」を緑にする";
    repo.setGoal("s1", text, 5);

    const goal = repo.getGoal("s1");
    assertEquals(goal, {
      text,
      iteration: 0,
      maxIterations: 5,
      status: "active",
    });
    // No judge verdict yet: the reason is absent, not an empty string.
    assertEquals(hasLastReason(goal), false);
  } finally {
    db.close();
  }
});

Deno.test("goal: setGoal replaces an existing goal and resets its progress", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);

    repo.setGoal("s1", "first goal", 3);
    repo.updateGoal("s1", {
      iteration: 2,
      status: "judging",
      lastReason: "half way",
    });
    assertEquals(repo.getGoal("s1")?.iteration, 2);

    // A second `/goal` in the same session starts from zero: an inherited
    // iteration count would eat the new goal's budget, and a stale reason
    // would be shown as this goal's last verdict.
    repo.setGoal("s1", "second goal", 7);
    const replaced = repo.getGoal("s1");
    assertEquals(replaced, {
      text: "second goal",
      iteration: 0,
      maxIterations: 7,
      status: "active",
    });
    assertEquals(hasLastReason(replaced), false);
  } finally {
    db.close();
  }
});

Deno.test("goal: updateGoal advances iteration and status like the goal loop", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);

    // The cap is deliberately not the column default (10): every update
    // rewrites goal_max_iterations from the stored row, so a wrong mapping
    // would silently reset the loop's budget.
    repo.setGoal("s1", "green tests", 4);

    // The two patches the loop sends (goal/loop.ts): `judging` before the
    // judge call, then `iteration + 1` / `active` with the verdict reason
    // when the goal is not achieved yet.
    repo.updateGoal("s1", { status: "judging" });
    assertEquals(repo.getGoal("s1"), {
      text: "green tests",
      iteration: 0,
      maxIterations: 4,
      status: "judging",
    });

    repo.updateGoal("s1", {
      iteration: 1,
      status: "active",
      lastReason: "3 tests fail",
    });
    assertEquals(repo.getGoal("s1"), {
      text: "green tests",
      iteration: 1,
      maxIterations: 4,
      status: "active",
      lastReason: "3 tests fail",
    });

    // Second loop pass: the reason survives the judging status and is
    // replaced by the newer verdict.
    repo.updateGoal("s1", { status: "judging" });
    assertEquals(repo.getGoal("s1"), {
      text: "green tests",
      iteration: 1,
      maxIterations: 4,
      status: "judging",
      lastReason: "3 tests fail",
    });
    repo.updateGoal("s1", {
      iteration: 2,
      status: "active",
      lastReason: "1 test fails",
    });
    assertEquals(repo.getGoal("s1"), {
      text: "green tests",
      iteration: 2,
      maxIterations: 4,
      status: "active",
      lastReason: "1 test fails",
    });
  } finally {
    db.close();
  }
});

Deno.test("goal: updateGoal keeps lastReason when undefined, clears it on null", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);
    repo.setGoal("s1", "green tests", 4);
    repo.updateGoal("s1", {
      iteration: 1,
      status: "active",
      lastReason: "3 tests fail",
    });
    assertEquals(repo.getGoal("s1")?.lastReason, "3 tests fail");

    // A patch without lastReason keeps the stored reason: `judging` is sent
    // on every loop pass, and dropping the reason there would blank the
    // panel's last verdict.
    repo.updateGoal("s1", { status: "judging" });
    assertEquals(repo.getGoal("s1"), {
      text: "green tests",
      iteration: 1,
      maxIterations: 4,
      status: "judging",
      lastReason: "3 tests fail",
    });

    // null is the explicit "drop the reason": the column goes back to NULL
    // and the field disappears from the snapshot.
    repo.updateGoal("s1", { lastReason: null });
    const cleared = repo.getGoal("s1");
    assertEquals(cleared, {
      text: "green tests",
      iteration: 1,
      maxIterations: 4,
      status: "judging",
    });
    assertEquals(hasLastReason(cleared), false);

    // A later patch without lastReason must not resurrect the cleared value.
    repo.updateGoal("s1", { iteration: 2, status: "active" });
    const afterClear = repo.getGoal("s1");
    assertEquals(afterClear?.iteration, 2);
    assertEquals(afterClear?.status, "active");
    assertEquals(hasLastReason(afterClear), false);
  } finally {
    db.close();
  }
});

Deno.test("goal: clearGoal wipes the goal columns the loop reloads", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);
    repo.setGoal("s1", "green tests", 4);
    repo.updateGoal("s1", {
      iteration: 2,
      status: "judging",
      lastReason: "1 test fails",
    });

    repo.clearGoal("s1");
    assertEquals(repo.getGoal("s1"), undefined);

    // The whole row state is reset, not just hidden behind the goal_text
    // NULL: the loop reloads the goal after clearing and must find none.
    const row = db.db.prepare(
      `SELECT goal_text, goal_iteration, goal_status, goal_last_reason
       FROM sessions WHERE id = 's1'`,
    ).get() as unknown as {
      goal_text: string | null;
      goal_iteration: number;
      goal_status: string | null;
      goal_last_reason: string | null;
    };
    assertEquals(row.goal_text, null);
    assertEquals(row.goal_iteration, 0);
    assertEquals(row.goal_status, null);
    assertEquals(row.goal_last_reason, null);

    // A cleared goal stays cleared: a late updateGoal (a judge result
    // racing the cancel) must not revive it.
    repo.updateGoal("s1", {
      iteration: 3,
      status: "active",
      lastReason: "late",
    });
    assertEquals(repo.getGoal("s1"), undefined);
  } finally {
    db.close();
  }
});

Deno.test("goal: a session without a goal ignores the goal updates", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);

    // A fresh session has goal_text NULL, so it has no goal to report.
    assertEquals(repo.getGoal("s1"), undefined);

    repo.updateGoal("s1", {
      iteration: 3,
      status: "judging",
      lastReason: "nothing to judge",
    });
    assertEquals(repo.getGoal("s1"), undefined);

    repo.clearGoal("s1");
    assertEquals(repo.getGoal("s1"), undefined);

    // Stale ids behave the same way: an UPDATE that matches no row is a
    // silent no-op, and none of these may throw or create a session.
    assertEquals(repo.getGoal("missing"), undefined);
    repo.setGoal("missing", "ghost goal", 4);
    repo.updateGoal("missing", { iteration: 1, status: "judging" });
    repo.clearGoal("missing");
    assertEquals(repo.get("missing"), undefined);
    assertEquals(repo.getGoal("missing"), undefined);
  } finally {
    db.close();
  }
});

Deno.test("goal: each session keeps its own goal", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);
    repo.create({
      id: "s2",
      workspaceId: "ws1",
      name: "test",
      modelProvider: "faux",
      modelId: "model",
      createdAt: 0,
      updatedAt: 0,
    });

    repo.setGoal("s1", "goal one", 3);
    assertEquals(repo.getGoal("s2"), undefined);

    repo.setGoal("s2", "goal two", 6);
    repo.updateGoal("s1", {
      iteration: 1,
      status: "judging",
      lastReason: "one",
    });

    assertEquals(repo.getGoal("s1"), {
      text: "goal one",
      iteration: 1,
      maxIterations: 3,
      status: "judging",
      lastReason: "one",
    });
    assertEquals(repo.getGoal("s2"), {
      text: "goal two",
      iteration: 0,
      maxIterations: 6,
      status: "active",
    });

    // Clearing one session's goal leaves the other's alone.
    repo.clearGoal("s1");
    assertEquals(repo.getGoal("s1"), undefined);
    assertEquals(repo.getGoal("s2"), {
      text: "goal two",
      iteration: 0,
      maxIterations: 6,
      status: "active",
    });
  } finally {
    db.close();
  }
});

Deno.test("goal: every goal write refreshes the session's updated_at", () => {
  const db = LumiscaDb.openInMemory();
  try {
    const repo = createSessionRepo(db);
    seedSession(db, repo);

    // The session list orders by updated_at (updatedAt starts at 0 here):
    // a stalled timestamp would sink a looping session to the bottom.
    repo.setGoal("s1", "green tests", 4);
    const afterSet = repo.get("s1")?.updatedAt ?? 0;
    assertEquals(afterSet > 0, true);

    repo.updateGoal("s1", { status: "judging" });
    assertEquals((repo.get("s1")?.updatedAt ?? 0) >= afterSet, true);

    repo.clearGoal("s1");
    assertEquals((repo.get("s1")?.updatedAt ?? 0) >= afterSet, true);
  } finally {
    db.close();
  }
});
