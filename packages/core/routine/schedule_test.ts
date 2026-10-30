import { assertEquals } from "@std/assert";
import {
  nextRunAt,
  parseSchedule,
  type RoutineSchedule,
  scheduleProblem,
} from "../shared/routine.ts";
import {
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  ROUTINE_NAME_MAX_CHARS,
  ROUTINES_PER_AGENT_MAX,
} from "../shared/routine.ts";

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
