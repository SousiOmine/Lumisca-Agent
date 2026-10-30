/**
 * Routines: prompts this conversation runs on a schedule.
 *
 * A routine is one saved request ("check the deploy and summarize it") plus
 * a time it should run at. The scheduler starts an ordinary run with it —
 * the same run a typed prompt starts — so everything the agent can do while
 * the user is watching, it can do while nobody is.
 *
 * The schedule is deliberately three shapes and nothing more (`daily`,
 * `weekly`, `every`): a cron expression is a language to learn, and every
 * real request so far has been one of them. Times are the server's local
 * time, because that is the clock the user reads; there is no timezone
 * setting, since a machine runs in one place.
 *
 * This module is frontend-safe (pure): the web bundle reads the limits and
 * renders the schedule labels through it, and the server computes the next
 * run from the same code, so the two can never disagree about when a
 * routine fires.
 */

/** When a routine runs. Times are `HH:MM` in the server's local time;
 * `days` is 1 = Monday … 7 = Sunday. */
export type RoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "every"; minutes: number };

/** How the last run ended. `running` is never stored — it is read from the
 * scheduler's memory — but the view type carries it so the UI has one
 * status field. */
export type RoutineStatus = "ok" | "error" | "stopped";

/** Longest routine name. Shown in a list row, not a document. */
export const ROUTINE_NAME_MAX_CHARS = 60;
/** Longest prompt. It becomes one user message on every run. */
export const ROUTINE_PROMPT_MAX_CHARS = 4_000;
/** Routines one agent may have. Bounds how much work a directory of
 * routines can schedule at once. */
export const ROUTINES_PER_AGENT_MAX = 50;
/** Shortest `every` interval: a routine that fires faster than that would
 * spend its life running into its own previous run. */
export const MIN_EVERY_MINUTES = 5;
/** Longest `every` interval (24 hours). */
export const MAX_EVERY_MINUTES = 1_440;

/** `HH:MM`, 24-hour, zero-padded (the only shape stored). */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A stored schedule, decoded. Unknown shapes are refused (the row then
 * reads as disabled instead of running at a guessed time). */
export function parseSchedule(value: unknown): RoutineSchedule | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind === "daily") {
    return typeof raw.time === "string" && TIME_PATTERN.test(raw.time)
      ? { kind: "daily", time: raw.time }
      : null;
  }
  if (kind === "weekly") {
    if (typeof raw.time !== "string" || !TIME_PATTERN.test(raw.time)) {
      return null;
    }
    if (!Array.isArray(raw.days) || raw.days.length === 0) return null;
    const days: number[] = [];
    for (const day of raw.days) {
      if (typeof day !== "number" || !Number.isInteger(day)) return null;
      if (day < 1 || day > 7 || days.includes(day)) return null;
      days.push(day);
    }
    return { kind: "weekly", days, time: raw.time };
  }
  if (kind === "every") {
    const minutes = raw.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes)) return null;
    return minutes >= MIN_EVERY_MINUTES && minutes <= MAX_EVERY_MINUTES
      ? { kind: "every", minutes }
      : null;
  }
  return null;
}

/** Why a schedule cannot be used, or null when it is fine. The message is
 * for the model (it built the value), so it states the accepted shapes. */
export function scheduleProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return 'the schedule must be an object: {"kind":"daily","time":"08:30"}';
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  switch (kind) {
    case "daily":
      return typeof raw.time === "string" && TIME_PATTERN.test(raw.time)
        ? null
        : "time must be HH:MM in 24-hour local time (e.g. 08:30)";
    case "weekly": {
      if (typeof raw.time !== "string" || !TIME_PATTERN.test(raw.time)) {
        return "time must be HH:MM in 24-hour local time (e.g. 18:00)";
      }
      if (!Array.isArray(raw.days) || raw.days.length === 0) {
        return "days must be a non-empty array of 1 (Monday) through 7 " +
          "(Sunday)";
      }
      const seen = new Set<number>();
      for (const day of raw.days) {
        if (!Number.isInteger(day) || typeof day !== "number") {
          return "days must contain whole numbers from 1 (Monday) to 7 " +
            "(Sunday)";
        }
        if (day < 1 || day > 7) {
          return "days must be 1 (Monday) through 7 (Sunday)";
        }
        if (seen.has(day)) return "days must not repeat a weekday";
        seen.add(day);
      }
      return null;
    }
    case "every":
      return typeof raw.minutes === "number" &&
          Number.isInteger(raw.minutes) &&
          raw.minutes >= MIN_EVERY_MINUTES &&
          raw.minutes <= MAX_EVERY_MINUTES
        ? null
        : `minutes must be a whole number from ${MIN_EVERY_MINUTES} to ` +
          `${MAX_EVERY_MINUTES}`;
    default:
      return 'kind must be "daily", "weekly" or "every"';
  }
}

/** The day of the week in the same numbering the schedules use
 * (1 = Monday … 7 = Sunday). `Date.getDay()` is 0 = Sunday … 6 = Saturday. */
function weekdayOf(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

/** Split `HH:MM` into hours and minutes (a validated stored value). */
function timeParts(time: string): [number, number] {
  const [hours, minutes] = time.split(":");
  return [Number(hours), Number(minutes)];
}

/**
 * The next time a schedule should fire, strictly after `from` (epoch ms).
 *
 * "Strictly after" is the whole point: a run that starts at its own
 * scheduled instant must not be scheduled again for the same instant, or a
 * daily routine would fire in a loop until the minute passed. Wall-clock
 * arithmetic goes through `Date`'s local setters, so a 08:30 routine stays
 * 08:30 across a daylight-saving change (and a 25-hour day still has one
 * 08:30).
 *
 * `every` is plain elapsed time from the instant it is asked about, which
 * is what "every 30 minutes" means to a user.
 */
export function nextRunAt(schedule: RoutineSchedule, from: number): number {
  switch (schedule.kind) {
    case "daily": {
      const [hours, minutes] = timeParts(schedule.time);
      const date = new Date(from);
      date.setHours(hours, minutes, 0, 0);
      if (date.getTime() <= from) {
        date.setDate(date.getDate() + 1);
        date.setHours(hours, minutes, 0, 0);
      }
      return date.getTime();
    }
    case "weekly": {
      const [hours, minutes] = timeParts(schedule.time);
      // Seven days ahead covers "today already passed": the same weekday
      // next week is the answer then.
      for (let offset = 0; offset <= 7; offset++) {
        const date = new Date(from);
        date.setDate(date.getDate() + offset);
        date.setHours(hours, minutes, 0, 0);
        if (date.getTime() <= from) continue;
        if (schedule.days.includes(weekdayOf(date))) return date.getTime();
      }
      // Unreachable with a validated schedule; a plain day keeps the
      // caller from getting a NaN (which would never fire).
      return from + 24 * 60 * 60 * 1_000;
    }
    case "every":
      return from + schedule.minutes * 60_000;
  }
}

/** One stored routine, as every layer above the database sees it. */
export interface Routine {
  id: string;
  /** The agent whose conversation it runs in. */
  agentId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  /** When it should run next (epoch ms); null when disabled or unreadable. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: RoutineStatus | null;
  /** Why the last run failed, or how it was stopped. */
  lastDetail: string | null;
  createdAt: number;
  updatedAt: number;
}
