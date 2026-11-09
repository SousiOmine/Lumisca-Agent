/**
 * The routine tools: create / list / update / delete / run.
 *
 * They are discoverable rather than preloaded (see tool-names.ts): a routine
 * is set up once and then runs by itself, so five definitions would be paid
 * for on every turn of every conversation. The model finds them through
 * `tool_search` when the user asks for something scheduled.
 *
 * Every tool is bound to ONE agent (the conversation asking), so a routine
 * can only be created, read, changed or run for the conversation the user is
 * actually in. Reaching another agent's routines is not an operation the
 * user can mean: routines are "this conversation's schedule".
 *
 * The schedule argument accepts an object or its JSON string (a model
 * sometimes hands JSON as text), and is normalized to the strict stored form
 * before anything is written.
 */
import {
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
  nextRunAt,
  type Routine,
  ROUTINE_NAME_MAX_CHARS,
  ROUTINE_PROMPT_MAX_CHARS,
  ROUTINES_PER_AGENT_MAX,
  type RoutineSchedule,
  scheduleProblem,
  TOOL_ROUTINE_CREATE,
  TOOL_ROUTINE_DELETE,
  TOOL_ROUTINE_LIST,
  TOOL_ROUTINE_RUN,
  TOOL_ROUTINE_UPDATE,
} from "../shared/mod.ts";
import { formatLocalDateTime, parseLocalDateTime } from "../shared/misc.ts";
import {
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import { CoreError } from "../errors.ts";
import type { RoutineRepo } from "./repo.ts";
import type { RoutineRunState, RoutineScheduler } from "./scheduler.ts";

/** Description of the schedule argument, shared by the two tools that take
 * one. */
const SCHEDULE_DESCRIPTION = '{"kind":"daily","time":"08:30"}, ' +
  '{"kind":"weekly","days":[1,5],"time":"18:00"} (1 = Monday), ' +
  '{"kind":"every","minutes":30}, ' +
  '{"kind":"once","at":"2026-11-12 09:00"} (one run at that local date and ' +
  "time; the routine removes itself from the list after it has run), or " +
  '{"kind":"watch","everyMinutes":10,' +
  '"source":{...}}. A watch runs only when its source changed: ' +
  '{"kind":"http","url":"https://...","expect":{"status":200}} or ' +
  '{"expect":{"includes":"..."}} or {"expect":{"hash":true}}, ' +
  '{"kind":"file","path":"app.log","compare":"mtime"} (or "hash"), or ' +
  '{"kind":"command","command":"...","expect":{"exitCode":0}} (or ' +
  '{"includes":"..."}). A watch is checked by the server without asking ' +
  "the model, so it costs nothing when nothing changed. A JSON string of " +
  "the same object is accepted too";

/** The accepted shapes as a refusal lists them. One wording for both tools,
 * so the description and the error cannot describe different sets. */
const SCHEDULE_SHAPES = '{"kind":"daily","time":"08:30"}, ' +
  '{"kind":"weekly","days":[1,5],"time":"18:00"}, ' +
  '{"kind":"every","minutes":30}, or {"kind":"once","at":"2026-11-12 ' +
  '09:00"}.';

/** The schedule argument: an object whose shape
 * {@link usableSchedule} checks (it owns the wording, so one validator
 * answers for both tools). Its properties stay open because the shapes have
 * different keys. */
const scheduleSchema = object({}, {
  additionalProperties: true,
  description: SCHEDULE_DESCRIPTION,
});

/** One routine as the model reads it: one line per routine, with the facts
 * needed to change it (the id) and to judge it (when it runs next, how the
 * last run ended). */
function describeRoutine(
  routine: Routine,
  runState: RoutineRunState,
): string {
  const parts = [
    `${routine.name} (id ${routine.id})`,
    scheduleText(routine.schedule),
    routine.enabled ? "enabled" : "disabled",
    routine.nextRunAt === null
      ? "no next run"
      : `next ${formatLocal(routine.nextRunAt)}`,
    routine.lastStatus === null
      ? "never run"
      : `last ${routine.lastStatus}${
        routine.lastDetail === null ? "" : ` (${routine.lastDetail})`
      }`,
  ];
  // The check is not a run, so it is said separately: a stopped machine is
  // not a routine that keeps failing (see scheduler.ts).
  if (routine.watchCheckedAt !== undefined) {
    parts.push(`last check ${formatLocal(routine.watchCheckedAt)}`);
  }
  if (routine.watchError !== undefined) {
    parts.push(`check failed: ${routine.watchError}`);
  }
  // "Waiting" is not "running": a run held back by a busy conversation has
  // produced nothing yet, and saying it is running would hide that.
  if (runState === "running") parts.push("running now");
  if (runState === "queued") {
    parts.push("waiting for the conversation to be free");
  }
  return `- ${parts.join("; ")}`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** What a watch looks at, in the words the model reads back. The condition
 * is part of it: "the file changed" and "the file contains X" are different
 * routines. */
export function watchSourceText(
  source: Extract<RoutineSchedule, { kind: "watch" }>["source"],
): string {
  switch (source.kind) {
    case "http": {
      const parts = [
        source.expect.status === undefined
          ? null
          : `status ${source.expect.status}`,
        source.expect.includes === undefined
          ? null
          : `body contains ${JSON.stringify(source.expect.includes)}`,
        source.expect.hash === true ? "body changed" : null,
      ].filter((part) => part !== null);
      return `${source.url} (${parts.join(", ")})`;
    }
    case "file":
      return `${source.path} (${
        source.compare === "hash" ? "content changed" : "modified"
      })`;
    case "command": {
      const parts = [
        source.expect.exitCode === undefined
          ? null
          : `exit ${source.expect.exitCode}`,
        source.expect.includes === undefined
          ? null
          : `output contains ${JSON.stringify(source.expect.includes)}`,
      ].filter((part) => part !== null);
      return `${JSON.stringify(source.command)} (${parts.join(", ")})`;
    }
  }
}

/** The schedule in words: "daily at 08:30", "weekly on Mon, Fri at 18:00",
 * "every 30 minutes", "once at 2026-11-12 09:00". The model reads this, so
 * it is short and unambiguous (and never a locale-dependent date format). */
export function scheduleText(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "watch": {
      // What is watched matters more than the cadence: "every 5 minutes"
      // says nothing about what the routine is for.
      return `watch ${
        watchSourceText(schedule.source)
      }, every ${schedule.everyMinutes} min`;
    }
    case "daily":
      return `daily at ${schedule.time}`;
    case "weekly": {
      const days = [...schedule.days].sort().map((day) =>
        WEEKDAYS[day - 1] ?? String(day)
      );
      return `weekly on ${days.join(", ")} at ${schedule.time}`;
    }
    case "every":
      return `every ${schedule.minutes} minutes`;
    case "once":
      return `once at ${schedule.at}`;
  }
}

/** `YYYY-MM-DD HH:MM` in the server's local time: what the user's clock
 * says, without the ambiguity of a bare epoch value. */
function formatLocal(at: number): string {
  return formatLocalDateTime(at);
}

/** A schedule the caller supplied, normalized; throws with the accepted
 * shapes when it cannot be used. */
function usableSchedule(value: unknown): RoutineSchedule {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new CoreError(
        `The schedule is not valid JSON: ${value}. Use ${SCHEDULE_SHAPES}`,
        "invalid",
      );
    }
  }
  const problem = scheduleProblem(raw);
  if (problem !== null) {
    throw new CoreError(
      `The schedule cannot be used (${problem}). Use ${SCHEDULE_SHAPES}`,
      "invalid",
    );
  }
  return raw as RoutineSchedule;
}

/** Why a one-off time cannot be scheduled, or null. A time that has already
 * passed would start on the next tick — "do it now" spelled as a routine
 * that disappears from the list — so the tool refuses it and says what to do
 * instead. A stored past time stays valid: that is how a one-off whose hour
 * came while the server was off runs when it comes back. */
function pastOneOffProblem(
  schedule: RoutineSchedule,
  now: number,
): string | null {
  if (schedule.kind !== "once") return null;
  const at = parseLocalDateTime(schedule.at);
  return at !== null && at <= now
    ? `the one-off time ${schedule.at} has already passed; pick a later ` +
      "time, or do the work now instead of scheduling it"
    : null;
}

export interface RoutineToolsOptions {
  repo: RoutineRepo;
  scheduler: RoutineScheduler;
  /** The agent whose conversation these tools act for. */
  agentId: string;
}

const createSchema = object({
  name: string(
    `Name shown in the list (1-${ROUTINE_NAME_MAX_CHARS} characters)`,
  ),
  prompt: string(
    "The request to run when it fires, written as you would want to read " +
      `it later (1-${ROUTINE_PROMPT_MAX_CHARS} characters)`,
  ),
  schedule: scheduleSchema,
});

const listSchema = object({});

const updateSchema = object({
  id: string("The routine's id (from routine_list)"),
  name: optional(string(
    `A new name (1-${ROUTINE_NAME_MAX_CHARS} characters)`,
  )),
  prompt: optional(string(
    `A new request (1-${ROUTINE_PROMPT_MAX_CHARS} characters)`,
  )),
  schedule: optional(scheduleSchema),
  enabled: optional(integer("1 to enable it, 0 to disable it")),
});

const deleteSchema = object({
  id: string("The routine's id (from routine_list)"),
});

const runSchema = object({
  id: string("The routine's id (from routine_list)"),
});

/** The routine this agent owns, or a failure naming how to find the right
 * one. */
function owned(
  repo: RoutineRepo,
  agentId: string,
  id: string,
): Routine {
  const routine = repo.get(id);
  if (routine === undefined) {
    throw new CoreError(
      `Routine ${id} does not exist. Use routine_list to see this ` +
        "conversation's routines.",
      "not_found",
    );
  }
  if (routine.agentId !== agentId) {
    throw new CoreError(
      `Routine ${id} belongs to another conversation. Use routine_list to ` +
        "see this conversation's routines.",
      "forbidden",
    );
  }
  return routine;
}

/** Build the five routine tools for one agent. */
export function createRoutineTools(options: RoutineToolsOptions): Tool[] {
  const { repo, scheduler, agentId } = options;

  const createTool: Tool<typeof createSchema> = {
    name: TOOL_ROUTINE_CREATE,
    label: "Routine Create",
    description:
      "Schedule a request to run in this conversation: on a schedule that " +
      "repeats, when a source changes, or once at a given local date and " +
      "time. Each run is an ordinary turn with `prompt` as the user's " +
      "message, so the agent can use every tool it normally has. Times are " +
      "the machine's local time; `weekly` days are 1 = Monday … 7 = Sunday. " +
      "A `once` routine runs a single time and is removed from the list " +
      `after that run. At most ${ROUTINES_PER_AGENT_MAX} routines per ` +
      "conversation; " +
      '"every" runs from ' +
      `${MIN_EVERY_MINUTES} to ${MAX_EVERY_MINUTES} minutes apart.`,
    parameters: createSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const name = params.name.trim();
      if (name.length === 0) {
        throw new CoreError("name must not be empty", "invalid");
      }
      if (name.length > ROUTINE_NAME_MAX_CHARS) {
        throw new CoreError(
          `name must be at most ${ROUTINE_NAME_MAX_CHARS} characters (got ` +
            `${name.length})`,
          "invalid",
        );
      }
      const prompt = params.prompt.trim();
      if (prompt.length === 0) {
        throw new CoreError("prompt must not be empty", "invalid");
      }
      if (prompt.length > ROUTINE_PROMPT_MAX_CHARS) {
        throw new CoreError(
          `prompt must be at most ${ROUTINE_PROMPT_MAX_CHARS} characters ` +
            `(got ${prompt.length})`,
          "invalid",
        );
      }
      const schedule = usableSchedule(params.schedule);
      const stale = pastOneOffProblem(schedule, Date.now());
      if (stale !== null) throw new CoreError(stale, "invalid");
      const existing = repo.listOf(agentId);
      if (existing.length >= ROUTINES_PER_AGENT_MAX) {
        throw new CoreError(
          `This conversation already has ${ROUTINES_PER_AGENT_MAX} routines, ` +
            "the maximum. Delete one with routine_delete first.",
          "conflict",
        );
      }
      if (existing.some((routine) => routine.name === name)) {
        throw new CoreError(
          `A routine named "${name}" already exists in this conversation. ` +
            "Choose another name, or change that one with routine_update.",
          "conflict",
        );
      }
      const routine = repo.create({ agentId, name, prompt, schedule });
      const oneOff = routine.schedule.kind === "once";
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Created routine "${routine.name}" (id ${routine.id}).\n` +
            `Schedule: ${scheduleText(routine.schedule)} (local time).\n` +
            `Next run: ${
              routine.nextRunAt === null
                ? "(none)"
                : formatLocal(routine.nextRunAt)
            } (local time).\n` +
            (oneOff
              ? "It runs once and is then removed from the list; its result " +
                "stays in this conversation."
              : "The result of each run appears in this conversation."),
        }],
        details: { id: routine.id, nextRunAt: routine.nextRunAt },
      });
    },
  };

  const listTool: Tool<typeof listSchema> = {
    name: TOOL_ROUTINE_LIST,
    label: "Routine List",
    description:
      "List this conversation's routines with their schedule, state and the " +
      "outcome of the last run.",
    parameters: listSchema,
    execute: (): Promise<ToolResult> => {
      const routines = repo.listOf(agentId);
      if (routines.length === 0) {
        return Promise.resolve({
          content: [{
            type: "text",
            text: "No routines yet. Create one with routine_create.",
          }],
          details: { count: 0 },
        });
      }
      return Promise.resolve({
        content: [{
          type: "text",
          text: routines
            .map((routine) =>
              describeRoutine(routine, scheduler.stateOf(routine.id))
            )
            .join("\n"),
        }],
        details: { count: routines.length },
      });
    },
  };

  const updateTool: Tool<typeof updateSchema> = {
    name: TOOL_ROUTINE_UPDATE,
    label: "Routine Update",
    description:
      "Change a routine's name, request, schedule, or whether it is " +
      "enabled. Only the fields you pass change. Disabling a routine keeps " +
      "it but stops it firing; the next run is recomputed when the schedule " +
      "or the enabled state changes.",
    parameters: updateSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const current = owned(repo, agentId, params.id);
      const name = params.name?.trim();
      if (name !== undefined) {
        if (name.length === 0) {
          throw new CoreError("name must not be empty", "invalid");
        }
        if (name.length > ROUTINE_NAME_MAX_CHARS) {
          throw new CoreError(
            `name must be at most ${ROUTINE_NAME_MAX_CHARS} characters (got ` +
              `${name.length})`,
            "invalid",
          );
        }
      }
      const prompt = params.prompt?.trim();
      if (prompt !== undefined) {
        if (prompt.length === 0) {
          throw new CoreError("prompt must not be empty", "invalid");
        }
        if (prompt.length > ROUTINE_PROMPT_MAX_CHARS) {
          throw new CoreError(
            `prompt must be at most ${ROUTINE_PROMPT_MAX_CHARS} characters ` +
              `(got ${prompt.length})`,
            "invalid",
          );
        }
      }
      const schedule = params.schedule === undefined
        ? undefined
        : usableSchedule(params.schedule);
      if (schedule !== undefined) {
        const stale = pastOneOffProblem(schedule, Date.now());
        if (stale !== null) throw new CoreError(stale, "invalid");
      }
      const enabled = params.enabled === undefined
        ? undefined
        : params.enabled !== 0;
      const willBeEnabled = enabled ?? current.enabled;
      const willRun = schedule ?? current.schedule;
      // The next run follows the new state: enabling (or changing the
      // schedule of an enabled routine) schedules from now, disabling
      // clears it.
      const nextRunAtValue = willBeEnabled
        ? nextRunAt(willRun, Date.now())
        : null;
      const updated = repo.update(current.id, {
        ...(name !== undefined ? { name } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        nextRunAt: nextRunAtValue,
      });
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Updated routine "${updated.name}" (id ${updated.id}).\n` +
            `Schedule: ${scheduleText(updated.schedule)} (local time).\n` +
            (updated.enabled
              ? `Next run: ${
                updated.nextRunAt === null
                  ? "(none)"
                  : formatLocal(updated.nextRunAt)
              } (local time).`
              : "It is disabled and will not run."),
        }],
        details: { id: updated.id, enabled: updated.enabled },
      });
    },
  };

  const deleteTool: Tool<typeof deleteSchema> = {
    name: TOOL_ROUTINE_DELETE,
    label: "Routine Delete",
    description:
      "Delete a routine. Its past runs stay in the conversation. This " +
      "cannot be undone, so ask the user to confirm before calling it.",
    parameters: deleteSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const routine = owned(repo, agentId, params.id);
      repo.delete(routine.id);
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Deleted routine "${routine.name}". Its past runs stay in ` +
            "the conversation.",
        }],
        details: { id: routine.id },
      });
    },
  };

  const runTool: Tool<typeof runSchema> = {
    name: TOOL_ROUTINE_RUN,
    label: "Routine Run",
    description:
      "Run a routine now, without changing when it next fires. The run " +
      "starts after any run already going finishes; its result appears in " +
      "this conversation. This returns as soon as the run is accepted.",
    parameters: runSchema,
    execute: (_id, params): Promise<ToolResult> => {
      const routine = owned(repo, agentId, params.id);
      // Not awaited: the run of a routine is a whole turn, and the tool that
      // asked for it must not keep the current turn open until it ends.
      void scheduler.runNow(routine.id).catch((error) => {
        // The failure is recorded on the routine by the scheduler; this
        // catch only stops an unhandled rejection.
        void error;
      });
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Started routine "${routine.name}". Its result appears in ` +
            "this conversation when it finishes.",
        }],
        details: { id: routine.id },
      });
    },
  };

  return [createTool, listTool, updateTool, deleteTool, runTool];
}
