/**
 * Routines: prompts this conversation runs on a schedule.
 *
 * A routine is one saved request ("check the deploy and summarize it") plus
 * a time it should run at. The scheduler starts an ordinary run with it —
 * the same run a typed prompt starts — so everything the agent can do while
 * the user is watching, it can do while nobody is.
 *
 * The schedule is deliberately a short list of shapes and nothing more
 * (`daily`, `weekly`, `every`, `once`, `watch`): a cron expression is a
 * language to learn, and every real request so far has been one of them.
 * Times are the server's local time, because that is the clock the user
 * reads; there is no timezone setting, since a machine runs in one place.
 *
 * `once` is the shape that has no next occurrence: it names a single local
 * date and time, and the routine is gone once that run has happened (see
 * routine/scheduler.ts). It is a shape rather than "a daily that switches
 * itself off" because the two answer different questions — a daily has a
 * next run by definition, and the scheduler's whole rule is that the next
 * run is advanced before the current one starts.
 *
 * This module is frontend-safe (pure): the web bundle reads the limits and
 * renders the schedule labels through it, and the server computes the next
 * run from the same code, so the two can never disagree about when a
 * routine fires.
 */
import { parseLocalDateTime } from "./misc.ts";
import { watchPathProblem } from "./watch-path.ts";

/** When a routine runs. Times are the server's local time: `HH:MM` for the
 * repeating shapes, `YYYY-MM-DD HH:MM` for `once`; `days` is 1 = Monday …
 * 7 = Sunday. */
export type RoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "every"; minutes: number }
  | { kind: "once"; at: string }
  | { kind: "watch"; everyMinutes: number; source: WatchSource };

/** What a `watch` routine looks at between runs.
 *
 * Every source is answered by the SERVER, never by the model: a step that
 * needs an inference call costs the same whether anything changed or not, so
 * a check the server cannot decide is not a watch — it is a schedule. That is
 * the whole point of this trigger, and the reason the three shapes below are
 * deliberately dumb.
 *
 * One consequence is that a watch reads only what the agent itself can see:
 * an HTTP response, a file, a command's exit status and output, or the answer
 * of an MCP tool. The last one is the exception to "the check runs inside the
 * machine": an MCP connection belongs to the server process, and the agent
 * calls through that same connection, so a check that ran anywhere else would
 * be watching something other than what the agent will act on (see
 * vm/watch.ts).
 *
 * Reading a page, judging a sentence or summarising a feed are things the RUN
 * does once the check fires — not things the check does to decide whether to
 * fire. */
export type WatchSource =
  | {
      kind: "http";
      url: string;
      /** Default GET. HEAD is refused for a body watch: there is no body. */
      method?: "GET";
      /** What counts as "changed". The first check only records a baseline:
       * nothing has been compared yet, so nothing can differ. */
      expect: {
        /** The status the check compares. A different status is a change. */
        status?: number;
        /** The body must contain this; absence is a change. */
        includes?: string;
        /** SHA-256 of the body; a different digest is a change. */
        hash?: boolean;
      };
    }
  | {
      kind: "file";
      path: string;
      /** What to compare. `mtime` is the cheaper one; `hash` notices an
       * edit that kept the timestamp. */
      compare: "mtime" | "hash";
    }
  | {
      kind: "command";
      /** Run through the same shell the agent uses, in its working folder:
       * a check the user could type into its terminal. */
      command: string;
      /** What counts as a change. At least one is required. */
      expect: {
        /** The exit status the check compares. */
        exitCode?: number;
        /** The stdout must contain this; absence is a change. */
        includes?: string;
      };
    }
  | {
      kind: "mcp";
      /** A server of the app-level config (Settings → MCP servers). A watch
       * cannot name a workspace's or a plugin's server: its agent has no
       * workspace, and a plugin's servers come and go with the plugin. */
      server: string;
      /** The tool's own name on that server (`GMAIL_FETCH_EMAILS`). Only a
       * read-only tool may be watched (see mcp/service.ts). */
      tool: string;
      /** The tool's arguments, fixed for every check: a watch is one question
       * asked again and again, not a search the check is free to change. */
      args: Record<string, unknown>;
      /** What counts as a change. Exactly one of the two. */
      expect:
        | {
            /** The field holding each item's identity. A watch on this fires
             * when an id appears that the previous check did not see, and stays
             * quiet when an item it already knew about is edited or removed. */
            ids: string;
          }
        | {
            /** The field whose value is compared: a different value is a
             * change. For "this number / this status changed", where there is
             * no list of items to compare. */
            hash: string;
          };
    };

/** Shortest `watch` interval. A check makes no inference call, so it can be
 * frequent — but it still touches the machine or the network, and a routine
 * that fires every minute spends the agent's time on nothing. Five minutes is
 * the same floor `every` uses. */
export const MIN_WATCH_MINUTES = 5;
/** Longest `watch` interval (24 hours). */
export const MAX_WATCH_MINUTES = 1_440;

/** Longest JSON an MCP watch's `args` may be. The arguments are a filter (a
 * query, a date range), not a document: a check that has to send a long body
 * is a run, not a check. Eight kilobytes is ordinary page size — far more
 * than any listing tool's filter needs, and small enough that the stored
 * schedule stays a row the list can read. */
export const MAX_WATCH_ARGS_CHARS = 8_192;

/** How the last run ended. `running` is never stored — it is read from the
 * scheduler's memory — but the view type carries it so the UI has one
 * status field. `skipped` is a run that waited for the conversation and gave
 * up before it started: nothing was run, and the row says why. */
export type RoutineStatus = "ok" | "error" | "stopped" | "skipped";

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
  if (kind === "once") {
    const at = raw.at;
    if (typeof at !== "string" || onceAtProblem(at) !== null) return null;
    return { kind: "once", at };
  }
  if (kind === "watch") {
    // The validator owns the rules (one wording for one check), so reading a
    // stored value is the same question asked in the opposite direction.
    if (watchProblem(raw) !== null) return null;
    return {
      kind: "watch",
      everyMinutes: raw.everyMinutes as number,
      source: raw.source as WatchSource,
    };
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
        return (
          "days must be a non-empty array of 1 (Monday) through 7 " + "(Sunday)"
        );
      }
      const seen = new Set<number>();
      for (const day of raw.days) {
        if (!Number.isInteger(day) || typeof day !== "number") {
          return (
            "days must contain whole numbers from 1 (Monday) to 7 " + "(Sunday)"
          );
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
    case "once":
      return onceAtProblem(raw.at);
    case "watch":
      return watchProblem(raw);
    default:
      return 'kind must be "daily", "weekly", "every", "once" or "watch"';
  }
}

/** Why a `once` schedule's `at` cannot be used, or null. `at` is the text
 * `formatLocalDateTime` writes, so a time read back from `routine_list` can
 * be written straight into a schedule. */
function onceAtProblem(value: unknown): string | null {
  if (typeof value !== "string") {
    return (
      'at must be "YYYY-MM-DD HH:MM" in local time, e.g. ' +
      '"2026-11-12 09:00"'
    );
  }
  return parseLocalDateTime(value) === null
    ? `at must be a real "YYYY-MM-DD HH:MM" local time, got "${value}"`
    : null;
}

/** Why a stored `watch` schedule cannot be used, or null. The message goes to
 * the model (it built the value), so it names the shape that works. */
function watchProblem(raw: Record<string, unknown>): string | null {
  const everyMinutes = raw.everyMinutes;
  if (
    typeof everyMinutes !== "number" ||
    !Number.isInteger(everyMinutes) ||
    everyMinutes < MIN_WATCH_MINUTES ||
    everyMinutes > MAX_WATCH_MINUTES
  ) {
    return (
      `everyMinutes must be a whole number from ${MIN_WATCH_MINUTES} ` +
      `to ${MAX_WATCH_MINUTES}`
    );
  }
  const source = raw.source;
  if (typeof source !== "object" || source === null) {
    return (
      'source must be an object: {"kind":"http","url":...}, ' +
      '{"kind":"file","path":...}, {"kind":"command","command":...} or ' +
      '{"kind":"mcp","server":...,"tool":...}'
    );
  }
  const watch = source as Record<string, unknown>;
  switch (watch.kind) {
    case "http": {
      if (typeof watch.url !== "string" || !/^https?:\/\//.test(watch.url)) {
        return "url must be an http:// or https:// address";
      }
      if (watch.method !== undefined && watch.method !== "GET") {
        return 'method must be "GET" (it is the only one a watch makes)';
      }
      return expectProblem(
        watch.expect,
        ["status", "includes", "hash"],
        'expect must name what counts as a change: {"status":200}, ' +
          '{"includes":"..."} or {"hash":true}',
      );
    }
    case "file":
      if (typeof watch.path !== "string" || watch.path.trim() === "") {
        return "path must be the file to watch";
      }
      return watch.compare === "mtime" || watch.compare === "hash"
        ? null
        : 'compare must be "mtime" or "hash"';
    case "command": {
      if (typeof watch.command !== "string" || watch.command.trim() === "") {
        return "command must be the command to run";
      }
      return expectProblem(
        watch.expect,
        ["exitCode", "includes"],
        'expect must name what counts as a change: {"exitCode":0} or ' +
          '{"includes":"..."}',
      );
    }
    case "mcp": {
      if (typeof watch.server !== "string" || watch.server.trim() === "") {
        return "server must name an MCP server from the app settings";
      }
      if (typeof watch.tool !== "string" || watch.tool.trim() === "") {
        return (
          "tool must be the tool's own name on that server " +
          '(e.g. "GMAIL_FETCH_EMAILS")'
        );
      }
      const args = watch.args;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return (
          "args must be an object of the tool's arguments ({} when it " +
          "takes none)"
        );
      }
      if (JSON.stringify(args).length > MAX_WATCH_ARGS_CHARS) {
        return (
          `args must be at most ${MAX_WATCH_ARGS_CHARS} characters of ` + "JSON"
        );
      }
      const problem = expectProblem(
        watch.expect,
        ["ids", "hash"],
        'expect must name what counts as a change: {"ids":"data.items[].id"} ' +
          'or {"hash":"data.count"}',
      );
      if (problem !== null) return problem;
      const expect = watch.expect as Record<string, unknown>;
      const named = Object.keys(expect).filter(
        (key) => expect[key] !== undefined,
      );
      const key = named[0];
      if (named.length !== 1 || key === undefined) {
        return "expect must name exactly one of ids or hash, not both";
      }
      return watchPathProblem(expect[key]);
    }
    default:
      return 'source.kind must be "http", "file", "command" or "mcp"';
  }
}

/** A watch's `expect` must be an object with at least one of `allowed`, and
 * nothing else: a field the checker does not read would be a rule the user
 * wrote and the server silently ignored. */
function expectProblem(
  value: unknown,
  allowed: readonly string[],
  message: string,
): string | null {
  if (typeof value !== "object" || value === null) return message;
  const expect = value as Record<string, unknown>;
  const named = Object.keys(expect).filter((key) => expect[key] !== undefined);
  if (named.length === 0) return message;
  const unknown = named.find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    return (
      `expect.${unknown} is not something a watch can compare; ` +
      `use ${allowed.join(", ")}`
    );
  }
  return null;
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
 *
 * `once` is the exception to "strictly after": it has a single instant and
 * no next one, so it answers with that instant even when it is already past.
 * Answering "past" is what lets a machine that was off at the time run the
 * request when it comes back. Nothing uses the answer to advance a one-off
 * — the scheduler clears its slot instead (see routine/scheduler.ts).
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
    case "once": {
      const at = parseLocalDateTime(schedule.at);
      if (at === null) {
        // A validated schedule always parses (parseSchedule and
        // scheduleProblem refuse the rest). Throwing keeps a value that
        // reached memory some other way from firing at a guessed time.
        throw new Error(`Unreadable one-off time: "${schedule.at}"`);
      }
      return at;
    }
    case "watch":
      // The CHECK runs on this cadence; whether a run follows is decided by
      // what the check saw (see vm/watch.ts). The interval is the same
      // elapsed-time arithmetic as `every`.
      return from + schedule.everyMinutes * 60_000;
  }
}

/** A stable name for what a schedule MEANS: two values that would fire the
 * routine the same way give the same key, whatever order their fields were
 * written in. An update uses it to tell "the same watch" from a new one —
 * comparing the stored JSON text would call a schedule changed because a key
 * moved, and would throw away a baseline that is still valid.
 *
 * Unknown extra fields are deliberately not part of the key: they are
 * refused before they are stored (`scheduleProblem`), and a value that
 * reached the database another way describes nothing the check reads. */
export function scheduleKey(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return JSON.stringify(["daily", schedule.time]);
    case "weekly":
      return JSON.stringify([
        "weekly",
        [...schedule.days].sort((a, b) => a - b),
        schedule.time,
      ]);
    case "every":
      return JSON.stringify(["every", schedule.minutes]);
    case "once":
      return JSON.stringify(["once", schedule.at]);
    case "watch":
      return JSON.stringify([
        "watch",
        schedule.everyMinutes,
        watchSourceKey(schedule.source),
      ]);
  }
}

/** The watched source as a comparable value: the fields the check reads, in
 * a fixed order (see {@link scheduleKey}). */
function watchSourceKey(source: WatchSource): unknown[] {
  switch (source.kind) {
    case "http":
      return [
        "http",
        source.url,
        source.method ?? "GET",
        source.expect.status ?? null,
        source.expect.includes ?? null,
        source.expect.hash === true,
      ];
    case "file":
      return ["file", source.path, source.compare];
    case "command":
      return [
        "command",
        source.command,
        source.expect.exitCode ?? null,
        source.expect.includes ?? null,
      ];
    case "mcp":
      return [
        "mcp",
        source.server,
        source.tool,
        canonicalJson(source.args),
        "ids" in source.expect
          ? ["ids", source.expect.ids]
          : ["hash", source.expect.hash],
      ];
  }
}

/** JSON with object keys sorted, so two spellings of the same arguments give
 * the same text (see scheduleKey): a watch whose args were rewritten in a
 * different key order is the same watch, and its baseline stays. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
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
  /** The last `watch` check's observation, as stored (see vm/watch.ts);
   * undefined for a routine that watches nothing, or one that has not been
   * checked since it was saved. Schedule routines never carry one. */
  watchState?: unknown;
  /** When the last `watch` check ran (epoch ms), or undefined when it never
   * did. A check is not a run: this and {@link watchError} are the check's
   * own record, while `lastRunAt` / `lastStatus` stay about runs. */
  watchCheckedAt?: number;
  /** Why the last check could not answer — a machine that is down, an
   * address that did not respond — or undefined when it answered. */
  watchError?: string;
  createdAt: number;
  updatedAt: number;
}

/** One routine as the settings list shows it: the stored row, the name of
 * the agent whose conversation it belongs to, and whether a run is in flight
 * right now (which lives in the scheduler, not the database). Defined here
 * because the route and the panel both name it — see shared/wire.ts's note. */
export interface RoutineView extends Routine {
  agentName: string;
  /** A run is going right now (the prompt reached the agent). */
  running: boolean;
  /** A run is waiting for the conversation to be free. Distinct from
   * `running` because a waiting run can sit there for a while, and the user
   * needs to know that is what they are looking at. */
  queued: boolean;
}
