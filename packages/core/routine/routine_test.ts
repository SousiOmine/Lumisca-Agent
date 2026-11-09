import { assert, assertEquals, assertThrows } from "@std/assert";
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
  options: {
    busy?: boolean;
    failure?: string | null;
    check?: Awaited<ReturnType<RoutineRunner["check"]>>;
  } = {},
): RoutineRunner & {
  started: string[];
  stopped: string[];
  checks: string[];
  release: () => void;
  setBusy: (value: boolean) => void;
} {
  const started: string[] = [];
  const stopped: string[] = [];
  const checks: string[] = [];
  let busy = options.busy === true;
  let release: () => void = () => {};
  return {
    started,
    stopped,
    checks,
    release: () => release(),
    /** Free the conversation (or block it again) mid-test. */
    setBusy: (value: boolean) => {
      busy = value;
    },
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
    check: () => {
      checks.push("checked");
      return Promise.resolve(
        options.check ??
          { kind: "same", state: { kind: "file", mtimeMs: 1, hash: null } },
      );
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
      slotPollMs: 5,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Still waiting: nothing started while the conversation is busy.
    assertEquals(fake.started.length, 0);
    assertEquals(scheduler.isRunning(created.id), true);
    // Free the conversation: the waiting run starts, and finishes, so the
    // test leaves nothing polling a database it is about to close.
    fake.setBusy(false);
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

/** A runner whose `run` settles at once: a watch test asserts that a run was
 * STARTED, and the blocking double above (which holds the run open so a test
 * can stop it) would keep the scheduler's promise pending past close() —
 * close() does not interrupt a run, so the test would never finish. */
function promptRunner(
  options: {
    check?: Awaited<ReturnType<RoutineRunner["check"]>>;
  } = {},
): RoutineRunner & { started: string[]; checks: string[] } {
  const started: string[] = [];
  const checks: string[] = [];
  return {
    started,
    checks,
    isRunning: () => false,
    run: (agentId, prompt, routine) => {
      started.push(`${agentId}:${routine.name}:${prompt}`);
      return Promise.resolve({ failure: null });
    },
    stop: () => {},
    check: () => {
      checks.push("checked");
      return Promise.resolve(
        options.check ??
          { kind: "same", state: { kind: "file", mtimeMs: 1, hash: null } },
      );
    },
  };
}

Deno.test("scheduler: a watch schedule checks instead of running", async () => {
  // The whole economy of the trigger: a due watch runs its CHECK, and a
  // check that saw nothing starts no run (and so no model call).
  const { repo: routines, close } = repo();
  try {
    const before = Date.now();
    routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "Summarise what appeared in the log",
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "app.log", compare: "mtime" },
      },
    });
    // Make it due now.
    const id = routines.listOf(AGENT)[0]!.id;
    routines.update(id, { nextRunAt: before - 1_000 });
    const fake = promptRunner();
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      tickMs: 10_000,
      catchUpDelayMs: 5,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.close();

    assertEquals(fake.checks.length, 1);
    // Nothing changed, so nothing ran.
    assertEquals(fake.started, []);
    // The check advanced the schedule, as a run would have.
    assert(routines.get(id)!.nextRunAt! > before);
  } finally {
    close();
  }
});

Deno.test("scheduler: a watch that saw a change starts the run", async () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "Summarise what appeared in the log",
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "app.log", compare: "mtime" },
      },
    });
    routines.update(created.id, { nextRunAt: Date.now() - 1_000 });
    const fake = runner({
      check: {
        kind: "changed",
        state: { kind: "file", mtimeMs: 2, hash: null },
      },
    });
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      tickMs: 10_000,
      catchUpDelayMs: 5,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.close();

    assertEquals(fake.checks.length, 1);
    assertEquals(fake.started.length, 1);
    assert(fake.started[0]!.includes("Summarise what appeared in the log"));
  } finally {
    close();
  }
});

Deno.test("scheduler: a check that could not answer does not fire the run", async () => {
  // A machine that is down or a URL that timed out observed nothing: firing
  // the routine for it turns every transient failure into a run.
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "p",
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "app.log", compare: "mtime" },
      },
    });
    routines.update(created.id, { nextRunAt: Date.now() - 1_000 });
    const fake = promptRunner({ check: { kind: "error", problem: "offline" } });
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      tickMs: 10_000,
      catchUpDelayMs: 5,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.close();

    assertEquals(fake.started, []);
    // The check's own record says why; the run's says nothing (it never ran).
    const row = routines.get(created.id)!;
    assertEquals(row.watchError, "offline");
    assertEquals(row.watchCheckedAt !== undefined, true);
    assertEquals(row.lastStatus, null);
    assertEquals(row.lastRunAt, null);
  } finally {
    close();
  }
});

Deno.test("routine repo: changing what a watch watches drops the baseline", () => {
  // The stored observation belongs to the watched thing. Carried across a
  // retarget it would compare a new file against an old one, and the first
  // look at the new file would fire the routine (see check.ts).
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "p",
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "a.log", compare: "mtime" },
      },
    });
    const baseline = { kind: "file", mtimeMs: 1, hash: null };
    routines.recordWatch(created.id, {
      state: baseline,
      nextRunAt: Date.now() + 300_000,
      checkedAt: Date.now(),
    });
    assertEquals(routines.get(created.id)?.watchState, baseline);

    // A name is not the watch: the baseline survives.
    const renamed = routines.update(created.id, { name: "Renamed" });
    assertEquals(renamed.watchState, baseline);

    // The same schedule written again (same meaning) is not a retarget.
    const same = routines.update(created.id, {
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "a.log", compare: "mtime" },
      },
    });
    assertEquals(same.watchState, baseline);

    // Another file is.
    const retargeted = routines.update(created.id, {
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "b.log", compare: "mtime" },
      },
    });
    assertEquals(retargeted.watchState, undefined);
  } finally {
    close();
  }
});

Deno.test("routine repo: switching a routine back on drops the baseline", () => {
  // While it was off nobody looked: the watched thing may have moved, and
  // comparing against the old value would fire a run for a change the user
  // never asked to be told about.
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "p",
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "a.log", compare: "mtime" },
      },
    });
    routines.recordWatch(created.id, {
      state: { kind: "file", mtimeMs: 1, hash: null },
      nextRunAt: 0,
      checkedAt: 0,
    });
    routines.update(created.id, { enabled: false, nextRunAt: null });
    const resumed = routines.update(created.id, {
      enabled: true,
      nextRunAt: Date.now() + 300_000,
    });
    assertEquals(resumed.watchState, undefined);
  } finally {
    close();
  }
});

Deno.test("scheduler: a check that cannot run backs off without recording a run", async () => {
  // The regression from #33: a stopped machine was asked every interval and
  // every failure was written as if the routine had run and failed, so the
  // list said "last failed a moment ago" about a routine that never ran.
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "p",
      schedule: {
        kind: "watch",
        everyMinutes: 5,
        source: { kind: "file", path: "app.log", compare: "mtime" },
      },
    });
    let clock = Date.now();
    routines.update(created.id, { nextRunAt: clock - 1_000 });
    const fake = promptRunner({
      check: { kind: "unsupported", problem: "the machine is not running" },
    });
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      now: () => clock,
      tickMs: 5,
      catchUpDelayMs: 5,
    });
    scheduler.start();
    // An hour of minutes: twelve intervals at the routine's own cadence.
    for (let minute = 0; minute < 60; minute++) {
      clock += 60_000;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    scheduler.close();

    // One look per fifteen minutes at most, not one per interval.
    assert(fake.checks.length <= 5, `${fake.checks.length} checks in an hour`);
    const row = routines.get(created.id)!;
    assertEquals(row.enabled, true, "a check that cannot run is not a stop");
    assertEquals(row.lastRunAt, null);
    assertEquals(row.lastStatus, null);
    assertEquals(row.watchError, "the machine is not running");
    assert(row.watchCheckedAt !== undefined);
  } finally {
    close();
  }
});

Deno.test("scheduler: a busy conversation keeps ONE waiting run, not six", async () => {
  // The regression from #38: every occurrence queued its own wait, so when
  // the conversation freed, six runs of the same request started at once.
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Every five",
      prompt: "p",
      schedule: { kind: "every", minutes: 5 },
    });
    let clock = Date.now();
    routines.update(created.id, { nextRunAt: clock - 1_000 });

    let busy = true;
    const started: string[] = [];
    const fake: RoutineRunner = {
      isRunning: () => busy,
      run: () => {
        started.push("run");
        return Promise.resolve({ failure: null });
      },
      stop: () => {},
      check: () =>
        Promise.resolve({
          kind: "same",
          state: { kind: "file", mtimeMs: 1, hash: null },
        }),
    };
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      now: () => clock,
      tickMs: 5,
      catchUpDelayMs: 5,
      slotPollMs: 5,
    });
    scheduler.start();
    // Thirty minutes of a five-minute routine: six occurrences.
    for (let minute = 0; minute < 30; minute++) {
      clock += 60_000;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(started, [], "nothing runs while the conversation is busy");
    assertEquals(scheduler.stateOf(created.id), "queued");
    assertEquals(scheduler.isQueued(created.id), true);

    // Free the conversation: ONE run starts, not the six occurrences.
    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(started, ["run"]);
    assertEquals(scheduler.stateOf(created.id), "idle");
    scheduler.close();
  } finally {
    close();
  }
});

Deno.test("scheduler: a wait that lasts too long gives up without recording a run", async () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Every five",
      prompt: "p",
      schedule: { kind: "every", minutes: 5 },
    });
    let clock = Date.now();
    routines.update(created.id, { nextRunAt: clock - 1_000 });
    const busyRunner: RoutineRunner = {
      isRunning: () => true,
      run: () => Promise.reject(new Error("must not run")),
      stop: () => {},
      check: () =>
        Promise.resolve({
          kind: "same",
          state: { kind: "file", mtimeMs: 1, hash: null },
        }),
    };
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: busyRunner,
      now: () => clock,
      tickMs: 5,
      catchUpDelayMs: 5,
      slotPollMs: 5,
      queueMaxWaitMs: 60_000,
    });
    scheduler.start();
    // The wait has to be under way before the clock jumps: the give-up is
    // measured from when this run started waiting.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEquals(scheduler.stateOf(created.id), "queued");
    clock += 120_000;
    await new Promise((resolve) => setTimeout(resolve, 60));

    const row = routines.get(created.id)!;
    assertEquals(row.lastStatus, "skipped");
    assert(row.lastDetail !== null && row.lastDetail.includes("skipped"));
    assertEquals(row.lastRunAt, null, "a run that never started has no time");
    assertEquals(scheduler.stateOf(created.id), "idle");
    scheduler.close();
  } finally {
    close();
  }
});

Deno.test("scheduler: stopping a waiting run records it without a run time", async () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Every five",
      prompt: "p",
      schedule: { kind: "every", minutes: 5 },
    });
    routines.update(created.id, { nextRunAt: Date.now() - 1_000 });
    const busyRunner: RoutineRunner = {
      isRunning: () => true,
      run: () => Promise.reject(new Error("must not run")),
      stop: () => {},
      check: () =>
        Promise.resolve({
          kind: "same",
          state: { kind: "file", mtimeMs: 1, hash: null },
        }),
    };
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: busyRunner,
      tickMs: 5,
      catchUpDelayMs: 5,
      slotPollMs: 5,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(scheduler.stateOf(created.id), "queued");
    scheduler.stop(created.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const row = routines.get(created.id)!;
    assertEquals(row.lastStatus, "stopped");
    assertEquals(row.lastRunAt, null);
    assertEquals(scheduler.stateOf(created.id), "idle");
    scheduler.close();
  } finally {
    close();
  }
});

Deno.test("scheduler: stopping one run does not swallow the next", async () => {
  // The stop marks were kept in one set for both cases, so stopping a run
  // that had already started left a cancellation behind that skipped the
  // routine's NEXT run (recorded as "stopped before it started").
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Check",
      prompt: "check it",
      schedule: { kind: "every", minutes: 30 },
    });
    const fake = runner();
    const scheduler = createRoutineScheduler({
      repo: routines,
      runner: fake,
      slotPollMs: 5,
    });
    const first = scheduler.runNow(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    scheduler.stop(created.id);
    fake.release();
    await first;
    assertEquals(routines.get(created.id)?.lastStatus, "stopped");

    // The next run starts as usual.
    const second = scheduler.runNow(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(fake.started.length, 2);
    fake.release();
    await second;
    assertEquals(routines.get(created.id)?.lastStatus, "ok");
  } finally {
    close();
  }
});
