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
import { formatLocalDateTime } from "../shared/misc.ts";
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
import type { RoutineScheduler } from "./scheduler.ts";

/** Description of the schedule argument, shared by the two tools that take
 * one: the three accepted shapes. */
const SCHEDULE_DESCRIPTION = '{"kind":"daily","time":"08:30"}, ' +
  '{"kind":"weekly","days":[1,5],"time":"18:00"} (1 = Monday), or ' +
  '{"kind":"every","minutes":30}. A JSON string of the same object is ' +
  "accepted too";

/** The schedule argument: an object whose shape
 * {@link usableSchedule} checks (it owns the wording, so one validator
 * answers for both tools). Its properties stay open because the three
 * shapes have different keys. */
const scheduleSchema = object({}, {
  additionalProperties: true,
  description: SCHEDULE_DESCRIPTION,
});

/** One routine as the model reads it: one line per routine, with the facts
 * needed to change it (the id) and to judge it (when it runs next, how the
 * last run ended). */
function describeRoutine(routine: Routine, running: boolean): string {
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
  if (running) parts.push("running now");
  return `- ${parts.join("; ")}`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The schedule in words: "daily at 08:30", "weekly on Mon, Fri at 18:00",
 * "every 30 minutes". The model reads this, so it is short and unambiguous
 * (and never a locale-dependent date format). */
export function scheduleText(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
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
        `The schedule is not valid JSON: ${value}. Use ` +
          '{"kind":"daily","time":"08:30"}, ' +
          '{"kind":"weekly","days":[1,5],"time":"18:00"}, or ' +
          '{"kind":"every","minutes":30}.',
        "invalid",
      );
    }
  }
  const problem = scheduleProblem(raw);
  if (problem !== null) {
    throw new CoreError(
      `The schedule cannot be used (${problem}). Use ` +
        '{"kind":"daily","time":"08:30"}, ' +
        '{"kind":"weekly","days":[1,5],"time":"18:00"}, or ' +
        '{"kind":"every","minutes":30}.',
      "invalid",
    );
  }
  return raw as RoutineSchedule;
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
      "Schedule a request to run in this conversation on a recurring " +
      "schedule. Each run is an ordinary turn with `prompt` as the user's " +
      "message, so the agent can use every tool it normally has. Times are " +
      "the machine's local time; `weekly` days are 1 = Monday … 7 = Sunday. " +
      `At most ${ROUTINES_PER_AGENT_MAX} routines per conversation; ` +
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
            "The result of each run appears in this conversation.",
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
              describeRoutine(
                routine,
                scheduler.isRunning(routine.id),
              )
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
