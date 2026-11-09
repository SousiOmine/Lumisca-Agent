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
import { machineWatchFetch, parseWatchState, runWatch } from "../vm/watch.ts";
import type { CommandRunner } from "../tools/command-backend.ts";
import type { FileBackend } from "../tools/file-backend.ts";

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

// --- the machine-side fetch ------------------------------------------------

/** A file backend over a Map: enough for the fetch's body file (written by
 * the fake curl, read back, removed). */
function fakeFiles(
  store: Map<string, string>,
  reads: number[] = [],
): FileBackend {
  return {
    roots: ["/home/agent"],
    readHead: (path: string, maxBytes: number) => {
      reads.push(maxBytes);
      const text = store.get(path);
      if (text === undefined) {
        return Promise.reject(new Error(`no such file: ${path}`));
      }
      const bytes = new TextEncoder().encode(text);
      return Promise.resolve({
        bytes: bytes.slice(0, maxBytes),
        size: bytes.length,
      });
    },
    removeFile: (path: string) => {
      store.delete(path);
      return Promise.resolve();
    },
  } as unknown as FileBackend;
}

/** A runner that answers like curl: it writes `body` where `-o` names it and
 * prints `status`, or fails with `stderr`. */
function curlingRunner(
  store: Map<string, string>,
  options: {
    body?: string;
    status?: string;
    exitCode?: number;
    stderr?: string;
  } = {},
): CommandRunner & { commands: string[]; cwds: string[] } {
  const commands: string[] = [];
  const cwds: string[] = [];
  return {
    commands,
    cwds,
    run: (command: string, runOptions) => {
      commands.push(command);
      cwds.push(runOptions.cwd);
      const target = /-o '([^']+)'/.exec(command)?.[1];
      if (target !== undefined) store.set(target, options.body ?? "");
      return Promise.resolve({
        stdout: options.status ?? "200",
        stderr: options.stderr ?? "",
        exitCode: options.exitCode ?? 0,
      } as never);
    },
  };
}

Deno.test("machineWatchFetch: the request goes out from the machine", async () => {
  // The whole point of #32: curl runs in the agent's folder, so the address
  // is one that machine can reach.
  const store = new Map<string, string>();
  const runner = curlingRunner(store, { body: "<html>deploy ok</html>" });
  const fetched = await machineWatchFetch({
    runner,
    files: fakeFiles(store),
    workdir: "/home/agent/agents/a1",
  })("https://example.com/x");

  assertEquals(fetched.status, 200);
  assertEquals(await fetched.text(), "<html>deploy ok</html>");
  assert(runner.commands[0]!.includes("curl"));
  assert(runner.commands[0]!.includes("https://example.com/x"));
  assertEquals(runner.commands[0]!.includes("-L"), true);
  assertEquals(runner.cwds, ["/home/agent/agents/a1"]);
  assertEquals(store.size, 0, "the body file is removed");
});

Deno.test("machineWatchFetch: the body is read through the file backend", async () => {
  const store = new Map<string, string>();
  const reads: number[] = [];
  const runner = curlingRunner(store, { body: "hello" });
  await machineWatchFetch({
    runner,
    files: fakeFiles(store, reads),
    workdir: "/home/agent/agents/a1",
  })("https://example.com/");
  // Bounded by the check's own body cap, not by the runner's output cap: the
  // runner's cap exists for a terminal, and would cut a page.
  assertEquals(reads.length, 1);
  assert(reads[0]! >= 5_000_000);
});

Deno.test("machineWatchFetch: an HTTP error is an observation", async () => {
  // A watch on "the status is 200" must fire when the server starts
  // answering 500, so a failing status is not a transport failure.
  const store = new Map<string, string>();
  const failure = await machineWatchFetch({
    runner: curlingRunner(store, { status: "500", body: "broken" }),
    files: fakeFiles(store),
    workdir: "/home/agent/agents/a1",
  })("https://example.com/");
  assertEquals(failure.status, 500);
  // A 204 has no body at all, and Response refuses one.
  const store2 = new Map<string, string>();
  const empty = await machineWatchFetch({
    runner: curlingRunner(store2, { status: "204" }),
    files: fakeFiles(store2),
    workdir: "/home/agent/agents/a1",
  })("https://example.com/empty");
  assertEquals(empty.status, 204);
  assertEquals(await empty.text(), "");
});

Deno.test("machineWatchFetch: a transport failure throws and cleans up", async () => {
  const store = new Map<string, string>();
  const runner = curlingRunner(store, {
    exitCode: 6,
    stderr: "curl: (6) Could not resolve host: nope.invalid",
  });
  let thrown: unknown;
  try {
    await machineWatchFetch({
      runner,
      files: fakeFiles(store),
      workdir: "/home/agent/agents/a1",
    })("https://nope.invalid/");
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error);
  assert(thrown.message.includes("Could not resolve host"));
  assertEquals(store.size, 0, "the body file is removed on failure too");
});

Deno.test("runWatch: an http check through the machine fetch compares like any other", async () => {
  // The fetch is a seam, so the check's own decisions must not depend on
  // which side of it the request runs: the baseline and the change are the
  // same.
  const store = new Map<string, string>();
  const source = {
    kind: "http",
    url: "https://example.com/",
    expect: { hash: true },
  } as const;
  const first = await runWatch(source, undefined, {
    runner: curlingRunner(store, { body: "one" }),
    workdir: "/home/agent/agents/a1",
    fetch: machineWatchFetch({
      runner: curlingRunner(store, { body: "one" }),
      files: fakeFiles(store),
      workdir: "/home/agent/agents/a1",
    }),
  });
  assertEquals(first.changed, false, "the first look is a baseline");

  const same = await runWatch(source, first.state!, {
    runner: curlingRunner(store, { body: "one" }),
    workdir: "/home/agent/agents/a1",
    fetch: machineWatchFetch({
      runner: curlingRunner(store, { body: "one" }),
      files: fakeFiles(store),
      workdir: "/home/agent/agents/a1",
    }),
  });
  assertEquals(same.changed, false);

  const changed = await runWatch(source, first.state!, {
    runner: curlingRunner(store, { body: "two" }),
    workdir: "/home/agent/agents/a1",
    fetch: machineWatchFetch({
      runner: curlingRunner(store, { body: "two" }),
      files: fakeFiles(store),
      workdir: "/home/agent/agents/a1",
    }),
  });
  assertEquals(changed.changed, true);
});
