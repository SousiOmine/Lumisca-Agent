import { assertEquals } from "@std/assert";
import {
  nextRunAt,
  parseSchedule,
  type RoutineSchedule,
  scheduleKey,
  scheduleProblem,
} from "../shared/routine.ts";
import {
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  ROUTINE_NAME_MAX_CHARS,
  ROUTINES_PER_AGENT_MAX,
} from "../shared/routine.ts";
import { formatLocalDateTime } from "../shared/misc.ts";

/** Monday 2026-10-26 09:00 local time (a fixed instant for the schedule
 * arithmetic; the tests build dates with local setters so the machine's
 * timezone does not matter). */
function local(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): number {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

Deno.test("routine schedule: a stored value is read strictly", () => {
  assertEquals(parseSchedule({ kind: "daily", time: "08:30" }), {
    kind: "daily",
    time: "08:30",
  });
  assertEquals(
    parseSchedule({ kind: "weekly", days: [1, 5], time: "18:00" }),
    { kind: "weekly", days: [1, 5], time: "18:00" },
  );
  assertEquals(parseSchedule({ kind: "every", minutes: 30 }), {
    kind: "every",
    minutes: 30,
  });
  // Anything else is unreadable rather than guessed at.
  assertEquals(parseSchedule(null), null);
  assertEquals(parseSchedule("daily"), null);
  assertEquals(parseSchedule({ kind: "daily", time: "8:30" }), null);
  assertEquals(parseSchedule({ kind: "daily", time: "24:00" }), null);
  assertEquals(
    parseSchedule({ kind: "weekly", days: [], time: "08:00" }),
    null,
  );
  assertEquals(
    parseSchedule({ kind: "weekly", days: [1, 1], time: "08:00" }),
    null,
  );
  assertEquals(parseSchedule({ kind: "every", minutes: 0 }), null);
  assertEquals(parseSchedule({ kind: "cron", expression: "* * * * *" }), null);
});

Deno.test("routine schedule: a bad value names what is accepted", () => {
  assertEquals(scheduleProblem({ kind: "daily", time: "08:30" }), null);
  const bad = scheduleProblem({ kind: "daily", time: "8:30" });
  assertEquals(bad !== null, true);
  assertEquals(bad!.includes("HH:MM"), true);
  const days = scheduleProblem({ kind: "weekly", days: [0], time: "08:00" });
  assertEquals(days !== null, true);
  assertEquals(days!.includes("1 (Monday)"), true);
  const minutes = scheduleProblem({ kind: "every", minutes: 1 });
  assertEquals(minutes !== null, true);
  assertEquals(minutes!.includes(String(MIN_EVERY_MINUTES)), true);
  const unknown = scheduleProblem({ kind: "yearly" });
  assertEquals(unknown !== null, true);
});

Deno.test("routine schedule: the next daily run is strictly after now", () => {
  const schedule: RoutineSchedule = { kind: "daily", time: "08:30" };
  // Before the time: today.
  assertEquals(
    nextRunAt(schedule, local(2026, 10, 26, 7, 0)),
    local(2026, 10, 26, 8, 30),
  );
  // Exactly at the time: tomorrow (the same instant must not fire twice).
  assertEquals(
    nextRunAt(schedule, local(2026, 10, 26, 8, 30)),
    local(2026, 10, 27, 8, 30),
  );
  // After it: tomorrow, crossing into the next month correctly.
  assertEquals(
    nextRunAt(schedule, local(2026, 10, 31, 9, 0)),
    local(2026, 11, 1, 8, 30),
  );
});

Deno.test("routine schedule: a weekly run finds the next chosen day", () => {
  // 2026-10-26 is a Monday.
  const schedule: RoutineSchedule = {
    kind: "weekly",
    days: [3, 5],
    time: "18:00",
  };
  assertEquals(
    nextRunAt(schedule, local(2026, 10, 26, 9, 0)),
    local(2026, 10, 28, 18, 0),
  );
  // Later on the chosen day, past its time: the following chosen day.
  assertEquals(
    nextRunAt(schedule, local(2026, 10, 28, 19, 0)),
    local(2026, 10, 30, 18, 0),
  );
  // After the last chosen day of the week: back to the first, next week.
  assertEquals(
    nextRunAt(schedule, local(2026, 10, 30, 19, 0)),
    local(2026, 11, 4, 18, 0),
  );
});

Deno.test("routine schedule: an interval counts from the instant asked", () => {
  const schedule: RoutineSchedule = { kind: "every", minutes: 30 };
  const from = local(2026, 10, 26, 9, 0);
  assertEquals(nextRunAt(schedule, from), from + 30 * 60_000);
});

Deno.test("routine schedule: a one-off is one local date and time", () => {
  // The stored text is what the list and `routine_list` show, so a value
  // read back from either can be written into a schedule unchanged.
  const schedule: RoutineSchedule = { kind: "once", at: "2026-11-12 09:00" };
  assertEquals(
    parseSchedule({ kind: "once", at: "2026-11-12 09:00" }),
    schedule,
  );
  assertEquals(
    formatLocalDateTime(nextRunAt(schedule, local(2026, 11, 10, 9, 0))),
    "2026-11-12 09:00",
  );
  // A past instant answers with itself: that is how a one-off whose hour
  // came while the machine was off runs when it comes back.
  assertEquals(
    nextRunAt(schedule, local(2026, 11, 20, 9, 0)),
    local(2026, 11, 12, 9, 0),
  );
  assertEquals(scheduleKey(schedule), scheduleKey({ ...schedule }));
  assertEquals(
    scheduleKey(schedule) ===
      scheduleKey({ kind: "once", at: "2026-11-12 09:01" }),
    false,
  );
});

Deno.test("routine schedule: a one-off must be a real minute", () => {
  assertEquals(scheduleProblem({ kind: "once", at: "2026-11-12 09:00" }), null);
  for (
    const at of [
      "2026-11-12", // no time
      "2026-11-12T09:00", // not the stored shape
      "2026-11-12 9:00", // not zero-padded
      "2026-11-12 24:00", // no such hour
      "2026-02-30 09:00", // `Date` would roll this over into March
      "",
    ]
  ) {
    assertEquals(parseSchedule({ kind: "once", at }), null, at);
    assertEquals(scheduleProblem({ kind: "once", at }) !== null, true, at);
  }
  // A missing `at` is refused instead of read as "now".
  assertEquals(parseSchedule({ kind: "once" }), null);
  assertEquals(scheduleProblem({ kind: "once" }) !== null, true);
});

Deno.test("routine limits are the documented ones", () => {
  assertEquals(ROUTINE_NAME_MAX_CHARS, 60);
  assertEquals(ROUTINES_PER_AGENT_MAX, 50);
  assertEquals(MIN_EVERY_MINUTES, 5);
  assertEquals(MAX_EVERY_MINUTES, 1_440);
  // The bounds are the ones `scheduleProblem` enforces.
  assertEquals(
    scheduleProblem({ kind: "every", minutes: MIN_EVERY_MINUTES }),
    null,
  );
  assertEquals(
    scheduleProblem({ kind: "every", minutes: MAX_EVERY_MINUTES }),
    null,
  );
  assertEquals(scheduleProblem({ kind: "every", minutes: 0 }) !== null, true);
  assertEquals(
    scheduleProblem({ kind: "every", minutes: MAX_EVERY_MINUTES + 1 }) !== null,
    true,
  );
});

Deno.test("routine schedule: the same meaning has the same key", () => {
  // An update compares keys to tell a retarget from a re-save: a schedule
  // written in another order (or with its days listed backwards) is the same
  // watch, and its baseline must survive.
  const monday: RoutineSchedule = {
    kind: "weekly",
    days: [1, 5],
    time: "18:00",
  };
  const listedAnotherWay: RoutineSchedule = {
    kind: "weekly",
    days: [5, 1],
    time: "18:00",
  };
  assertEquals(scheduleKey(monday), scheduleKey(listedAnotherWay));

  const watch = {
    kind: "watch",
    everyMinutes: 10,
    source: {
      kind: "http",
      url: "https://example.com",
      expect: { status: 200 },
    },
  } as const;
  const writtenAnotherWay = {
    source: {
      expect: { status: 200 },
      url: "https://example.com",
      kind: "http",
    },
    everyMinutes: 10,
    kind: "watch",
  } as RoutineSchedule;
  assertEquals(scheduleKey(watch), scheduleKey(writtenAnotherWay));

  // A different condition is a different watch.
  assertEquals(
    scheduleKey(watch) === scheduleKey({
      kind: "watch",
      everyMinutes: 10,
      source: {
        kind: "http",
        url: "https://example.com",
        expect: { status: 500 },
      },
    }),
    false,
  );
  // Two sources that would read as one line keep their own identity.
  assertEquals(
    scheduleKey({
      kind: "watch",
      everyMinutes: 10,
      source: { kind: "file", path: "a", compare: "hash" },
    }) === scheduleKey({
      kind: "watch",
      everyMinutes: 10,
      source: { kind: "file", path: "a", compare: "mtime" },
    }),
    false,
  );
});

Deno.test("routine schedule: an mcp watch names a read tool and one path", () => {
  const schedule = {
    kind: "watch",
    everyMinutes: 10,
    source: {
      kind: "mcp",
      server: "composio",
      tool: "GMAIL_FETCH_EMAILS",
      args: { query: "is:unread" },
      expect: { ids: "data.messages[].id" },
    },
  } as const;
  assertEquals(scheduleProblem(schedule), null);
  assertEquals(parseSchedule(schedule), schedule);

  // Both conditions at once would leave the check guessing which one was
  // meant.
  assertEquals(
    scheduleProblem({
      ...schedule,
      source: { ...schedule.source, expect: { ids: "a[].id", hash: "b" } },
    }) !== null,
    true,
  );
  assertEquals(
    scheduleProblem({
      ...schedule,
      source: { ...schedule.source, expect: { ids: "a[0]" } },
    }) !== null,
    true,
  );
  assertEquals(
    scheduleProblem({
      ...schedule,
      source: { ...schedule.source, server: "" },
    }) !== null,
    true,
  );
  // Args are a filter, not a document.
  assertEquals(
    scheduleProblem({
      ...schedule,
      source: { ...schedule.source, args: { body: "x".repeat(9_000) } },
    }) !== null,
    true,
  );
});

Deno.test("routine schedule: an mcp watch's args are compared without order", () => {
  const watch = (args: Record<string, unknown>) =>
    ({
      kind: "watch",
      everyMinutes: 10,
      source: {
        kind: "mcp",
        server: "composio",
        tool: "GMAIL_FETCH_EMAILS",
        args,
        expect: { ids: "data.messages[].id" },
      },
    }) as RoutineSchedule;
  // A saved routine whose args were rewritten in another key order is the
  // same watch, so its baseline must survive.
  assertEquals(
    scheduleKey(watch({ query: "is:unread", limit: 10 })),
    scheduleKey(watch({ limit: 10, query: "is:unread" })),
  );
  // A different question to the same tool is a different watch.
  assertEquals(
    scheduleKey(watch({ query: "is:unread" })) ===
      scheduleKey(watch({ query: "label:work" })),
    false,
  );
});
