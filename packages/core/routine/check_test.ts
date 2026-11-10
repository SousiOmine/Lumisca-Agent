import { assert, assertEquals } from "@std/assert";
import type { CommandRunner } from "../tools/command-backend.ts";
import type { FileBackend } from "../tools/file-backend.ts";
import { LumiscaDb } from "../db/mod.ts";
import type { RoutineRepo } from "./repo.ts";
import { createRoutineRepo } from "./repo.ts";
import { checkRoutine } from "./check.ts";
import type { RoutineSchedule } from "../shared/routine.ts";

/**
 * The check as the scheduler drives it: a routine from the repository, its
 * stored observation, and the answer.
 *
 * These are the tests the watch bugs needed: `packages/core/routine/
 * routine_test.ts` replaces `check` with a double, so a broken connection
 * between the repository and the check (the baseline never read) went
 * unnoticed. Here the repository is the real one and `runWatch` is the real
 * one; only the machine is a double.
 */

const AGENT = "agent-1";

function repo(): { repo: RoutineRepo; close: () => void } {
  const db = LumiscaDb.openInMemory();
  db.db.prepare(
    "INSERT INTO stella_agents (id, name, role, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  ).run(AGENT, "Worker", "Works.", 1, 1);
  return { repo: createRoutineRepo(db), close: () => db.close() };
}

/** A machine whose commands answer from a queue (the file check's stat). */
function runnerOf(
  stdout: string[],
  seen: string[] = [],
): CommandRunner {
  let index = 0;
  return {
    run: (command: string) => {
      seen.push(command);
      return Promise.resolve({
        stdout: stdout[index++] ?? "",
        stderr: "",
        exitCode: 0,
      } as never);
    },
  };
}

/** A file backend that only has to exist: the file check never reads one. */
const FILES = { roots: ["/home/agent"] } as unknown as FileBackend;

const fileWatch: RoutineSchedule = {
  kind: "watch",
  everyMinutes: 5,
  source: { kind: "file", path: "app.log", compare: "mtime" },
};

Deno.test("checkRoutine: the stored observation is the baseline it compares", async () => {
  // The regression from #31: the routine is what carries the previous
  // observation, so a second check must see the first one.
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the log",
      prompt: "Summarise what appeared in the log",
      schedule: fileWatch,
    });
    const deps = (at: string) => ({
      machine: {
        runner: runnerOf([`${at}\n`]),
        files: FILES,
        workdir: "/home/agent/agents/a1",
      },
    });

    const first = await checkRoutine(
      routines.get(created.id)!,
      deps("1700000000"),
    );
    assertEquals(first.kind, "same", "the first look is a baseline");
    assert(first.kind === "same");
    routines.recordWatch(created.id, {
      state: first.state,
      nextRunAt: Date.now() + 300_000,
      checkedAt: Date.now(),
    });

    const reRead = routines.get(created.id)!;
    assert(reRead.watchState !== undefined, "the observation was stored");
    const same = await checkRoutine(reRead, deps("1700000000"));
    assertEquals(same.kind, "same");

    const moved = await checkRoutine(
      routines.get(created.id)!,
      deps("1700000100"),
    );
    assertEquals(moved.kind, "changed");
  } finally {
    close();
  }
});

Deno.test("checkRoutine: two routines on one source keep their own baselines", async () => {
  // Looked up by source, the second routine would compare against the
  // first's observation and fire on nothing.
  const { repo: routines, close } = repo();
  try {
    const a = routines.create({
      agentId: AGENT,
      name: "A",
      prompt: "p",
      schedule: fileWatch,
    });
    const b = routines.create({
      agentId: AGENT,
      name: "B",
      prompt: "p",
      schedule: fileWatch,
    });
    routines.recordWatch(a.id, {
      state: { kind: "file", mtimeMs: 1, hash: null },
      nextRunAt: 0,
      checkedAt: 0,
    });

    const deps = (at: string) => ({
      machine: {
        runner: runnerOf([`${at}\n`]),
        files: FILES,
        workdir: "/home/agent/agents/a1",
      },
    });
    // B has no baseline: its first look records one instead of firing.
    assertEquals(
      (await checkRoutine(routines.get(b.id)!, deps("1700000002"))).kind,
      "same",
    );
    // A's own baseline is untouched by B's check.
    assertEquals(
      (await checkRoutine(routines.get(a.id)!, deps("1700000002"))).kind,
      "changed",
    );
  } finally {
    close();
  }
});

Deno.test("checkRoutine: a routine that watches nothing is unsupported", async () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Morning",
      prompt: "p",
      schedule: { kind: "daily", time: "08:30" },
    });
    const check = await checkRoutine(routines.get(created.id)!, {
      machine: {
        runner: runnerOf([]),
        files: FILES,
        workdir: "/home/agent/agents/a1",
      },
    });
    assertEquals(check.kind, "unsupported");
  } finally {
    close();
  }
});

Deno.test("checkRoutine: an http check goes out through the machine", async () => {
  // Not the host's fetch: curl runs in the agent's folder (see #32).
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the deploy page",
      prompt: "p",
      schedule: {
        kind: "watch",
        everyMinutes: 10,
        source: {
          kind: "http",
          url: "https://example.com/deploy",
          expect: { status: 200 },
        },
      },
    });
    const store = new Map<string, string>();
    const seen: string[] = [];
    const runner: CommandRunner = {
      run: (command: string) => {
        seen.push(command);
        const target = /-o '([^']+)'/.exec(command)?.[1];
        if (target !== undefined) store.set(target, "ok");
        return Promise.resolve({
          stdout: "200",
          stderr: "",
          exitCode: 0,
        } as never);
      },
    };
    const files = {
      roots: ["/home/agent"],
      readHead: (path: string, maxBytes: number) => {
        const bytes = new TextEncoder().encode(store.get(path) ?? "");
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

    const check = await checkRoutine(routines.get(created.id)!, {
      machine: {
        runner,
        files,
        workdir: "/home/agent/agents/a1",
      },
    });
    assertEquals(check.kind, "same");
    assertEquals(seen.length, 1);
    assert(seen[0]!.includes("curl"));
    assert(seen[0]!.includes("https://example.com/deploy"));
    assertEquals(store.size, 0, "the body file is removed");
  } finally {
    close();
  }
});

Deno.test("checkRoutine: an mcp check runs without the machine", async () => {
  // The one source whose check does not go through the container: the agent
  // calls the server through the same connection the check uses, so a
  // mailbox watch keeps working while the machine is down.
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the inbox",
      prompt: "Tell me what is new",
      schedule: {
        kind: "watch",
        everyMinutes: 10,
        source: {
          kind: "mcp",
          server: "composio",
          tool: "GMAIL_FETCH_EMAILS",
          args: { query: "is:unread" },
          expect: { ids: "data.messages[].id" },
        },
      },
    });
    routines.recordWatch(created.id, {
      state: { kind: "mcp", ids: ["m1"], hash: null },
      nextRunAt: Date.now() + 600_000,
      checkedAt: Date.now(),
    });
    const check = await checkRoutine(routines.get(created.id)!, {
      callTool: () =>
        Promise.resolve(JSON.stringify({
          data: { messages: [{ id: "m1" }, { id: "m2" }] },
        })),
    });
    assertEquals(check.kind, "changed");
    assert(check.kind === "changed");
    assertEquals(check.newItems, 1);
  } finally {
    close();
  }
});

Deno.test("checkRoutine: an mcp check without a connection is unsupported", async () => {
  const { repo: routines, close } = repo();
  try {
    const created = routines.create({
      agentId: AGENT,
      name: "Watch the inbox",
      prompt: "p",
      schedule: {
        kind: "watch",
        everyMinutes: 10,
        source: {
          kind: "mcp",
          server: "composio",
          tool: "GMAIL_FETCH_EMAILS",
          args: {},
          expect: { ids: "data.messages[].id" },
        },
      },
    });
    const check = await checkRoutine(routines.get(created.id)!, {
      machine: {
        runner: runnerOf([]),
        files: FILES,
        workdir: "/home/agent/agents/a1",
      },
    });
    assertEquals(check.kind, "unsupported");
  } finally {
    close();
  }
});
