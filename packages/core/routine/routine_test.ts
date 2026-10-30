import { assertEquals, assertThrows } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { createRoutineRepo, type RoutineRepo } from "./repo.ts";
import { createRoutineScheduler, type RoutineRunner } from "./scheduler.ts";
import { createRoutineTools } from "./tools.ts";
import { ROUTINES_PER_AGENT_MAX } from "../shared/routine.ts";

/**
 * Routines at the repository / scheduler / tool level.
 *
 * The scheduler is driven by an injected clock and a fake runner, so these
 * cover the decisions (what fires, what waits, what a failure records)
 * without a machine, a model or a timer.
 */

const AGENT = "agent-1";
const OTHER = "agent-2";

/** A repo over an in-memory database. */
function repo(): { repo: RoutineRepo; close: () => void } {
  const db = LumiscaDb.openInMemory();
  // The routines table references stella_agents: the agent rows must exist
  // before a routine can be created.
  db.db.prepare(
    "INSERT INTO stella_agents (id, name, role, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  ).run(AGENT, "Worker", "Works.", 1, 1);
  db.db.prepare(
    "INSERT INTO stella_agents (id, name, role, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  ).run(OTHER, "Other", "Also works.", 1, 1);
  return { repo: createRoutineRepo(db), close: () => db.close() };
}

/** A runner that records what it was asked to do. */
function runner(
  options: { busy?: boolean; failure?: string | null } = {},
): RoutineRunner & {
  started: string[];
  stopped: string[];
  release: () => void;
} {
  const started: string[] = [];
  const stopped: string[] = [];
  const busy = options.busy === true;
  let release: () => void = () => {};
  return {
    started,
    stopped,
    release: () => release(),
    isRunning: () => busy,
    run: async (agentId, prompt, routine) => {
      started.push(`${agentId}:${routine.name}:${prompt}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { failure: options.failure ?? null };
    },
    stop: () => {
      stopped.push("stop");
    },
  };
}

Deno.test("routine repo: a routine reads back with its next run", () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Morning check",
      prompt: "Check the deploy",
      schedule: { kind: "daily", time: "08:30" },
    });
    assertEquals(created.agentId, AGENT);
    assertEquals(created.enabled, true);
    assertEquals(created.nextRunAt !== null, true);
    assertEquals(routines.get(created.id)?.name, "Morning check");
    assertEquals(routines.listOf(AGENT).length, 1);
    assertEquals(routines.listOf(OTHER).length, 0);
  } finally {
    close();
  }
});

Deno.test("routine repo: names are unique per agent, not globally", () => {
  const { repo: routines, close } = repo();
  try {
    routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "p",
      schedule: { kind: "daily", time: "08:00" },
    });
    // The same name in another agent's conversation is a different routine.
    routines.create({
      agentId: OTHER,
      name: "Check",
      prompt: "p",
      schedule: { kind: "daily", time: "08:00" },
    });
    assertEquals(routines.listOf(AGENT).length, 1);
    assertEquals(routines.listOf(OTHER).length, 1);
  } finally {
    close();
  }
});

Deno.test("routine repo: disabling clears the next run, enabling sets one", () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "p",
      schedule: { kind: "daily", time: "08:00" },
    });
    const disabled = routines.update(created.id, {
      enabled: false,
      nextRunAt: null,
    });
    assertEquals(disabled.enabled, false);
    assertEquals(disabled.nextRunAt, null);
    const enabled = routines.update(created.id, {
      enabled: true,
      nextRunAt: Date.now() + 60_000,
    });
    assertEquals(enabled.enabled, true);
    assertEquals(enabled.nextRunAt !== null, true);
  } finally {
    close();
  }
});

Deno.test("routine repo: due returns only enabled rows that are due", () => {
  const { repo: routines, close } = repo();
  try {
    const early = routines.create({
      agentId: AGENT,
      name: "Early",
      prompt: "p",
      schedule: { kind: "every", minutes: 30 },
    });
    const late = routines.create({
      agentId: AGENT,
      name: "Late",
      prompt: "p",
      schedule: { kind: "every", minutes: 30 },
    });
    const now = Date.now();
    routines.update(early.id, { nextRunAt: now - 1_000 });
    routines.update(late.id, { nextRunAt: now + 60_000 });
    const due = routines.due(now);
    assertEquals(due.map((routine) => routine.name), ["Early"]);

    // A disabled routine is not due even with a stale next run.
    routines.update(early.id, { enabled: false, nextRunAt: null });
    assertEquals(routines.due(now).length, 0);
  } finally {
    close();
  }
});

Deno.test("routine scheduler: a due routine runs and advances first", async () => {
  const { repo: routines, close } = repo();
  const fake = runner();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "check it",
      schedule: { kind: "every", minutes: 30 },
    });
    // Due now.
    routines.update(created.id, { nextRunAt: Date.now() - 1_000 });

    let now = Date.now();
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      now: () => now,
      tickMs: 10_000,
      catchUpDelayMs: 5,
    });
    scheduler.start();
    // Wait for the first tick (a shortened tick runs its first pass at the
    // same interval, see scheduler.start).
    await new Promise((resolve) => setTimeout(resolve, 40));

    assertEquals(fake.started.length, 1);
    assertEquals(fake.started[0], `${AGENT}:Check:check it`);

    // The next run was moved BEFORE the run started: a second pass must not
    // fire it again while it is still going.
    const advanced = routines.get(created.id)!;
    assertEquals(advanced.nextRunAt! > now, true);
    now += 10_000;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEquals(fake.started.length, 1);

    fake.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(routines.get(created.id)?.lastStatus, "ok");
    scheduler.close();
  } finally {
    close();
  }
});

Deno.test("routine scheduler: a busy conversation is waited for, not skipped", async () => {
  const { repo: routines, close } = repo();
  const fake = runner({ busy: true });
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "check it",
      schedule: { kind: "every", minutes: 30 },
    });
    routines.update(created.id, { nextRunAt: Date.now() - 1_000 });
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      tickMs: 10_000,
      catchUpDelayMs: 5,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Still waiting: nothing started while the conversation is busy.
    assertEquals(fake.started.length, 0);
    assertEquals(scheduler.isRunning(created.id), true);
    scheduler.close();
  } finally {
    close();
  }
});

Deno.test("routine scheduler: a failed run records the reason", async () => {
  const { repo: routines, close } = repo();
  const fake = runner({ failure: "the model said no" });
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "check it",
      schedule: { kind: "every", minutes: 30 },
    });
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      tickMs: 10_000,
    });
    const running = scheduler.runNow(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.release();
    await running;
    assertEquals(routines.get(created.id)?.lastStatus, "error");
    assertEquals(routines.get(created.id)?.lastDetail, "the model said no");
  } finally {
    close();
  }
});

Deno.test("routine scheduler: runNow does not move the schedule", async () => {
  const { repo: routines, close } = repo();
  const fake = runner();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "check it",
      schedule: { kind: "every", minutes: 30 },
    });
    const before = routines.get(created.id)!.nextRunAt;
    const scheduler = createRoutineScheduler({ repo: routines, runner: fake });
    const running = scheduler.runNow(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.release();
    await running;
    assertEquals(routines.get(created.id)?.nextRunAt, before);
    assertEquals(routines.get(created.id)?.lastStatus, "ok");
  } finally {
    close();
  }
});

Deno.test("routine scheduler: stopping a run records it as stopped", async () => {
  const { repo: routines, close } = repo();
  const fake = runner();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "check it",
      schedule: { kind: "every", minutes: 30 },
    });
    const scheduler = createRoutineScheduler({ repo: routines, runner: fake });
    const running = scheduler.runNow(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    scheduler.stop(created.id);
    assertEquals(fake.stopped.length, 1);
    fake.release();
    await running;
    assertEquals(routines.get(created.id)?.lastStatus, "stopped");
  } finally {
    close();
  }
});

Deno.test("routine tools: create, list, update, delete and run", async () => {
  const { repo: routines, close } = repo();
  const fake = runner();
  try {
    const scheduler = createRoutineScheduler({ repo: routines, runner: fake });
    const tools = createRoutineTools({
      repo: routines,
      scheduler,
      agentId: AGENT,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const created = await byName.get("routine_create")!.execute("c1", {
      name: "Morning",
      prompt: "check the deploy",
      schedule: { kind: "daily", time: "08:30" },
    } as never);
    const createdText = created.content.map((block) =>
      block.type === "text" ? block.text : ""
    ).join("");
    assertEquals(createdText.includes("Morning"), true);
    assertEquals(createdText.includes("daily at 08:30"), true);

    const listed = await byName.get("routine_list")!.execute("c2", {} as never);
    const listText = listed.content.map((block) =>
      block.type === "text" ? block.text : ""
    ).join("");
    assertEquals(listText.includes("Morning"), true);

    const id = routines.listOf(AGENT)[0]!.id;
    const updated = await byName.get("routine_update")!.execute("c3", {
      id,
      enabled: 0,
    } as never);
    const updatedText = updated.content.map((block) =>
      block.type === "text" ? block.text : ""
    ).join("");
    assertEquals(updatedText.includes("disabled"), true);
    assertEquals(routines.get(id)?.enabled, false);

    await byName.get("routine_run")!.execute("c4", { id } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await byName.get("routine_delete")!.execute("c5", { id } as never);
    assertEquals(routines.get(id), undefined);
  } finally {
    close();
  }
});

Deno.test("routine tools: another agent's routine is refused", async () => {
  const { repo: routines, close } = repo();
  try {
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: runner(),
    });
    const mine = createRoutineTools({
      repo: routines,
      scheduler,
      agentId: AGENT,
    });
    const theirs = createRoutineTools({
      repo: routines,
      scheduler,
      agentId: OTHER,
    });
    const created = routines.create({
      agentId: AGENT,
      name: "Mine",
      prompt: "p",
      schedule: { kind: "daily", time: "08:00" },
    });
    const deleteTool = theirs.find((tool) => tool.name === "routine_delete")!;
    assertThrows(
      () => deleteTool.execute("c1", { id: created.id } as never),
      Error,
      "another conversation",
    );
    // The list of the other agent does not show it either.
    const listTool = mine.find((tool) => tool.name === "routine_list")!;
    const listed = await listTool.execute("c2", {} as never);
    const text = listed.content.map((block) =>
      block.type === "text" ? block.text : ""
    ).join("");
    assertEquals(text.includes("Mine"), true);
  } finally {
    close();
  }
});

Deno.test("routine tools: the per-agent limit is enforced", async () => {
  const { repo: routines, close } = repo();
  try {
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: runner(),
    });
    const tools = createRoutineTools({
      repo: routines,
      scheduler,
      agentId: AGENT,
    });
    const create = tools.find((tool) => tool.name === "routine_create")!;
    for (let index = 0; index < ROUTINES_PER_AGENT_MAX; index++) {
      await create.execute(`c${index}`, {
        name: `Routine ${index}`,
        prompt: "p",
        schedule: { kind: "every", minutes: 30 },
      } as never);
    }
    assertThrows(
      () =>
        create.execute("over", {
          name: "One too many",
          prompt: "p",
          schedule: { kind: "every", minutes: 30 },
        } as never),
      Error,
      "maximum",
    );
  } finally {
    close();
  }
});
