/**
 * Routines: storage.
 *
 * Same shape as the other repositories (one row in, one record out), with
 * two rules that matter more than the rest:
 *
 * - a broken `schedule` cell reads as a DISABLED routine instead of an
 *   error: a row written by an older build (or edited by hand) must not
 *   stop the scheduler from reading every other row, and it must not run at
 *   a guessed time either;
 * - `next_run_at` is advanced by the scheduler BEFORE the run starts, not
 *   after it finishes. A routine whose run takes an hour would otherwise be
 *   due again on every tick for that hour, and fire in parallel with
 *   itself.
 */
import type { LumiscaDb } from "../db/mod.ts";
import {
  nextRunAt,
  parseSchedule,
  type Routine,
  type RoutineSchedule,
  type RoutineStatus,
} from "../shared/mod.ts";
import { CoreError } from "../errors.ts";

interface RoutineRow {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_detail: string | null;
  created_at: number;
  updated_at: number;
}

/** What a stored schedule that cannot be read becomes: disabled, with no
 * next run, and a detail that says why (the settings list shows it). */
const UNREADABLE_SCHEDULE: RoutineSchedule = { kind: "daily", time: "00:00" };
const UNREADABLE_DETAIL = "The stored schedule could not be read";

function toRoutine(row: RoutineRow): Routine {
  let schedule: RoutineSchedule;
  let readable = true;
  try {
    const parsed = parseSchedule(JSON.parse(row.schedule));
    if (parsed === null) throw new Error("unreadable");
    schedule = parsed;
  } catch {
    schedule = UNREADABLE_SCHEDULE;
    readable = false;
  }
  const enabled = readable && row.enabled === 1;
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    schedule,
    enabled,
    nextRunAt: readable ? row.next_run_at : null,
    lastRunAt: row.last_run_at,
    lastStatus: statusOf(row.last_status),
    lastDetail: readable ? row.last_detail : UNREADABLE_DETAIL,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function statusOf(value: string | null): RoutineStatus | null {
  return value === "ok" || value === "error" || value === "stopped"
    ? value
    : null;
}

export interface CreateRoutineInput {
  agentId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
}

/** Partial update: an absent field keeps its value, `nextRunAt: null`
 * clears it (a disabled routine has no next run). */
export interface UpdateRoutineInput {
  name?: string;
  prompt?: string;
  schedule?: RoutineSchedule;
  enabled?: boolean;
  nextRunAt?: number | null;
}

export interface RoutineRunResult {
  lastRunAt: number;
  lastStatus: RoutineStatus;
  lastDetail: string | null;
  nextRunAt: number | null;
}

export interface RoutineRepo {
  list(): Routine[];
  listOf(agentId: string): Routine[];
  get(id: string): Routine | undefined;
  /** The routine of this agent with this name, if any (names are unique per
   * agent; the check lives here so the tool and the API agree). */
  findByName(agentId: string, name: string): Routine | undefined;
  /** Create a routine. Throws `conflict` when the name is taken. */
  create(input: CreateRoutineInput): Routine;
  update(id: string, patch: UpdateRoutineInput): Routine;
  delete(id: string): boolean;
  /** The routines that are due at `at`, oldest due first. */
  due(at: number): Routine[];
  /** Record how a run ended and when the next one is. */
  recordRun(id: string, result: RoutineRunResult): void;
}

const COLUMNS =
  "id, agent_id, name, prompt, schedule, enabled, next_run_at, last_run_at, " +
  "last_status, last_detail, created_at, updated_at";

export function createRoutineRepo(db: LumiscaDb): RoutineRepo {
  const listStmt = db.db.prepare(
    `SELECT ${COLUMNS} FROM routines ORDER BY created_at ASC, rowid ASC`,
  );
  const listOfStmt = db.db.prepare(
    `SELECT ${COLUMNS} FROM routines WHERE agent_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const getStmt = db.db.prepare(
    `SELECT ${COLUMNS} FROM routines WHERE id = ?`,
  );
  const byNameStmt = db.db.prepare(
    `SELECT ${COLUMNS} FROM routines WHERE agent_id = ? AND name = ?`,
  );
  const insertStmt = db.db.prepare(
    `INSERT INTO routines (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStmt = db.db.prepare(
    `UPDATE routines SET name = ?, prompt = ?, schedule = ?, enabled = ?,
       next_run_at = ?, last_run_at = ?, last_status = ?, last_detail = ?,
       updated_at = ?
     WHERE id = ?`,
  );
  const deleteStmt = db.db.prepare("DELETE FROM routines WHERE id = ?");
  const dueStmt = db.db.prepare(
    `SELECT ${COLUMNS} FROM routines
     WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at ASC, created_at ASC, rowid ASC`,
  );
  const runStmt = db.db.prepare(
    `UPDATE routines SET last_run_at = ?, last_status = ?, last_detail = ?,
       next_run_at = ?
     WHERE id = ?`,
  );

  const rowOf = (id: string): RoutineRow | undefined =>
    getStmt.get(id) as unknown as RoutineRow | undefined;

  return {
    list(): Routine[] {
      return (listStmt.all() as unknown as RoutineRow[]).map(toRoutine);
    },

    listOf(agentId: string): Routine[] {
      return (listOfStmt.all(agentId) as unknown as RoutineRow[]).map(
        toRoutine,
      );
    },

    get(id: string): Routine | undefined {
      const row = rowOf(id);
      return row === undefined ? undefined : toRoutine(row);
    },

    findByName(agentId: string, name: string): Routine | undefined {
      const row = byNameStmt.get(agentId, name) as unknown as
        | RoutineRow
        | undefined;
      return row === undefined ? undefined : toRoutine(row);
    },

    create(input: CreateRoutineInput): Routine {
      if (this.findByName(input.agentId, input.name) !== undefined) {
        throw new CoreError(
          `A routine named "${input.name}" already exists for this agent`,
          "conflict",
        );
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      const next = nextRunAt(input.schedule, now);
      insertStmt.run(
        id,
        input.agentId,
        input.name,
        input.prompt,
        JSON.stringify(input.schedule),
        1,
        next,
        null,
        null,
        null,
        now,
        now,
      );
      const created = this.get(id);
      if (created === undefined) {
        throw new CoreError(`Could not read back routine ${id}`, "not_found");
      }
      return created;
    },

    update(id: string, patch: UpdateRoutineInput): Routine {
      const current = rowOf(id);
      if (current === undefined) {
        throw new CoreError(`Routine not found: ${id}`, "not_found");
      }
      const name = patch.name ?? current.name;
      if (
        patch.name !== undefined &&
        patch.name !== current.name &&
        this.findByName(current.agent_id, name) !== undefined
      ) {
        throw new CoreError(
          `A routine named "${name}" already exists for this agent`,
          "conflict",
        );
      }
      const schedule = patch.schedule ??
        (parseSchedule(JSON.parse(current.schedule)) ?? UNREADABLE_SCHEDULE);
      const enabled = patch.enabled ?? current.enabled === 1;
      // The caller decides the next run when it changed anything that
      // affects it (a schedule edit, a toggle); otherwise the stored value
      // survives the update untouched.
      const next = patch.nextRunAt !== undefined
        ? patch.nextRunAt
        : current.next_run_at;
      updateStmt.run(
        name,
        patch.prompt ?? current.prompt,
        JSON.stringify(schedule),
        enabled ? 1 : 0,
        enabled ? next : null,
        current.last_run_at,
        current.last_status,
        current.last_detail,
        Date.now(),
        id,
      );
      const updated = this.get(id);
      if (updated === undefined) {
        throw new CoreError(`Routine not found: ${id}`, "not_found");
      }
      return updated;
    },

    delete(id: string): boolean {
      const result = deleteStmt.run(id);
      return Number(result.changes) > 0;
    },

    due(at: number): Routine[] {
      return (dueStmt.all(at) as unknown as RoutineRow[])
        .map(toRoutine)
        .filter((routine) => routine.enabled);
    },

    recordRun(id: string, result: RoutineRunResult): void {
      runStmt.run(
        result.lastRunAt,
        result.lastStatus,
        result.lastDetail,
        result.nextRunAt,
        id,
      );
    },
  };
}
