/**
 * The `watch` schedule: what it accepts, what it stores, and what it counts
 * as a change.
 */
import { assert, assertEquals } from "@std/assert";
import {
  MIN_WATCH_MINUTES,
  nextRunAt,
  parseSchedule,
  type RoutineSchedule,
  scheduleProblem,
} from "../shared/routine.ts";
import { parseWatchState, runWatch } from "../vm/watch.ts";
import type { CommandRunner } from "../tools/command-backend.ts";

function watch(
  source: Extract<RoutineSchedule, { kind: "watch" }>["source"],
  everyMinutes = 10,
): RoutineSchedule {
  return { kind: "watch", everyMinutes, source };
}

Deno.test("watch: an http watch is accepted and read back", () => {
  const schedule = watch({
    kind: "http",
    url: "https://example.com/deploy",
    expect: { status: 200 },
  });
  assertEquals(scheduleProblem(schedule), null);
  assertEquals(parseSchedule(schedule), schedule);
});

Deno.test("watch: every source shape is accepted", () => {
  for (
    const source of [
      { kind: "http", url: "https://example.com", expect: { hash: true } },
      { kind: "file", path: "out/report.md", compare: "hash" },
      { kind: "command", command: "test -f done", expect: { exitCode: 0 } },
    ] as const
  ) {
    assertEquals(scheduleProblem(watch(source)), null);
  }
});

Deno.test("watch: a bad interval, url, compare or expect is refused", () => {
  // Each message names what to fix, because the model wrote the value.
  assert(
    scheduleProblem(watch({ kind: "file", path: "a", compare: "mtime" }, 1))!
      .includes(String(MIN_WATCH_MINUTES)),
  );
  assert(
    scheduleProblem(watch({ kind: "http", url: "ftp://x", expect: {} }))!
      .includes("http"),
  );
  assert(
    scheduleProblem(
      watch({ kind: "file", path: "a", compare: "size" } as never),
    )!
      .includes("mtime"),
  );
  // An empty expect is a watch with no question: refused rather than stored,
  // because it would fire on nothing.
  assert(
    scheduleProblem(watch({ kind: "command", command: "ls", expect: {} })) !==
      null,
  );
});

Deno.test("watch: a field the checker does not read is refused", () => {
  // A rule the user wrote and the server ignored would be worse than an
  // error: the routine would look like it watched something it does not.
  const problem = scheduleProblem(watch({
    kind: "http",
    url: "https://example.com",
    expect: { status: 200, contains: "x" },
  } as never));
  assert(problem !== null);
  assert(problem.includes("expect.contains"));
});

Deno.test("watch: nextRunAt is the check cadence", () => {
  const from = 1_000_000;
  assertEquals(
    nextRunAt(watch({ kind: "file", path: "a", compare: "mtime" }, 10), from),
    from + 600_000,
  );
});

/** A runner double: `run` answers with whatever the test queued. */
function runnerOf(
  answers: Array<{ stdout?: string; exitCode?: number; stderr?: string }>,
): CommandRunner {
  let index = 0;
  return {
    run: () =>
      Promise.resolve({
        stdout: answers[index]?.stdout ?? "",
        stderr: answers[index]?.stderr ?? "",
        exitCode: answers[index++]?.exitCode ?? 0,
      } as never),
  };
}

const deps = (runner: CommandRunner) => ({
  runner,
  workdir: "/home/agent/agents/a1",
});

Deno.test("runWatch: the first check is a baseline, never a change", async () => {
  // Nothing has been compared yet, so nothing can differ. Firing here would
  // run the routine the moment it was saved.
  const runner = runnerOf([{ stdout: "1700000000\n" }]);
  const outcome = await runWatch(
    { kind: "file", path: "a", compare: "mtime" },
    undefined,
    deps(runner),
  );
  assertEquals(outcome.changed, false);
  assert(outcome.state !== null);
});

Deno.test("runWatch: a file whose timestamp moved is a change", async () => {
  const runner = runnerOf([
    { stdout: "1700000000\n" },
    { stdout: "1700000100\n" },
  ]);
  const source = { kind: "file", path: "a", compare: "mtime" } as const;
  const first = await runWatch(source, undefined, deps(runner));
  const second = await runWatch(source, first.state!, deps(runner));
  assertEquals(second.changed, true);
});

Deno.test("runWatch: a command that fails the check is the change", async () => {
  const runner = runnerOf([{ exitCode: 0 }, { exitCode: 1 }]);
  const source = {
    kind: "command",
    command: "git diff --quiet",
    expect: { exitCode: 0 },
  } as const;
  const first = await runWatch(source, undefined, deps(runner));
  const second = await runWatch(source, first.state!, deps(runner));
  assertEquals(second.changed, true);
});

Deno.test("runWatch: an http watch compares only what it names", async () => {
  // A status watch must not fire because the page's words changed.
  let status = 200;
  let body = "one";
  const fake = (() =>
    Promise.resolve(
      new Response(body, { status }),
    )) as unknown as typeof fetch;
  const source = {
    kind: "http",
    url: "https://example.com",
    expect: { status: 200 },
  } as const;
  const first = await runWatch(source, undefined, {
    ...deps(runnerOf([])),
    fetch: fake,
  });
  body = "two";
  const same = await runWatch(source, first.state!, {
    ...deps(runnerOf([])),
    fetch: fake,
  });
  assertEquals(same.changed, false);
  status = 503;
  const fired = await runWatch(source, first.state!, {
    ...deps(runnerOf([])),
    fetch: fake,
  });
  assertEquals(fired.changed, true);
});

Deno.test("runWatch: an unreachable address is a problem, not a change", async () => {
  // A machine offline or a site down must not fire the routine: there was
  // nothing to compare.
  const fake =
    (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  const outcome = await runWatch(
    { kind: "http", url: "https://example.com", expect: { status: 200 } },
    { kind: "http", status: 200, hash: null, hasIncludes: false },
    { ...deps(runnerOf([])), fetch: fake },
  );
  assertEquals(outcome.state, null);
  assertEquals(outcome.changed, false);
  assert(outcome.problem !== undefined);
});

Deno.test("parseWatchState: an unreadable state reads as no state", () => {
  // The next check must then be a baseline: an unreadable comparison must
  // not fire a run.
  assertEquals(parseWatchState(undefined), undefined);
  assertEquals(parseWatchState({ kind: "http" }), undefined);
  assertEquals(
    parseWatchState({ kind: "command", exitCode: 0, hasIncludes: false }),
    { kind: "command", exitCode: 0, hasIncludes: false },
  );
});
