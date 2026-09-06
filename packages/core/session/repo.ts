import type { LumiscaDb } from "../db/mod.ts";
import type { SessionInfo } from "../types/session.ts";
import type { GoalInfo, GoalStatus } from "../shared/goal.ts";

export interface SessionRecord extends SessionInfo {}

export interface GoalUpdate {
  iteration?: number;
  status?: GoalStatus;
  /** Undefined leaves the reason unchanged; null clears it; a string sets it. */
  lastReason?: string | null;
}

export interface SessionRepo {
  create(
    input: Omit<SessionInfo, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: number;
      updatedAt?: number;
    },
  ): SessionRecord;
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  delete(id: string): void;
  touch(id: string, updatedAt?: number): void;
  updateModel(id: string, provider: string, modelId: string): void;
  rename(id: string, name: string): void;
  updateSystemPrompt(id: string, systemPrompt: string): void;
  /** The session's active goal, if any (goal_text NULL means none). */
  getGoal(id: string): GoalInfo | undefined;
  /** Start (or replace) the session's active goal. Resets the progress. */
  setGoal(id: string, text: string, maxIterations: number): void;
  /** Update the active goal's progress (no-op when there is none). */
  updateGoal(id: string, patch: GoalUpdate): void;
  /** Drop the active goal (completion, limit, cancel, or rewind). */
  clearGoal(id: string): void;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  name: string;
  model_provider: string;
  model_id: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
  goal_text?: string | null;
  goal_iteration?: number | null;
  goal_max_iterations?: number | null;
  goal_status?: string | null;
  goal_last_reason?: string | null;
}

function toGoal(row: SessionRow): GoalInfo | undefined {
  if (row.goal_text === undefined || row.goal_text === null) return undefined;
  const text = row.goal_text.trim();
  if (text.length === 0) return undefined;
  const status = row.goal_status === "judging" ? "judging" : "active";
  return {
    text,
    iteration: row.goal_iteration ?? 0,
    maxIterations: row.goal_max_iterations ?? 10,
    status,
    ...(row.goal_last_reason ? { lastReason: row.goal_last_reason } : {}),
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    systemPrompt: row.system_prompt ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSessionRepo(db: LumiscaDb): SessionRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, system_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.db.prepare("SELECT * FROM sessions WHERE id = ?");
  const listStmt = db.db.prepare(
    "SELECT * FROM sessions ORDER BY updated_at DESC",
  );
  const listByWorkspaceStmt = db.db.prepare(
    "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC",
  );
  const deleteStmt = db.db.prepare("DELETE FROM sessions WHERE id = ?");
  const touchStmt = db.db.prepare(
    "UPDATE sessions SET updated_at = ? WHERE id = ?",
  );
  const updateModelStmt = db.db.prepare(
    "UPDATE sessions SET model_provider = ?, model_id = ?, updated_at = ? WHERE id = ?",
  );
  const renameStmt = db.db.prepare(
    "UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?",
  );
  const updateSystemPromptStmt = db.db.prepare(
    "UPDATE sessions SET system_prompt = ? WHERE id = ?",
  );
  const setGoalStmt = db.db.prepare(`
    UPDATE sessions
    SET goal_text = ?, goal_iteration = 0, goal_max_iterations = ?,
        goal_status = 'active', goal_last_reason = NULL, updated_at = ?
    WHERE id = ?
  `);
  const clearGoalStmt = db.db.prepare(`
    UPDATE sessions
    SET goal_text = NULL, goal_iteration = 0,
        goal_status = NULL, goal_last_reason = NULL, updated_at = ?
    WHERE id = ?
  `);

  return {
    create(input): SessionRecord {
      const id = input.id ?? crypto.randomUUID();
      const createdAt = input.createdAt ?? Date.now();
      const updatedAt = input.updatedAt ?? createdAt;
      insertStmt.run(
        id,
        input.workspaceId,
        input.name,
        input.modelProvider,
        input.modelId,
        input.systemPrompt ?? null,
        createdAt,
        updatedAt,
      );
      return {
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        systemPrompt: input.systemPrompt,
        createdAt,
        updatedAt,
      };
    },

    get(id: string): SessionRecord | undefined {
      const row = getStmt.get(id) as unknown as SessionRow | undefined;
      return row ? toSession(row) : undefined;
    },

    list(workspaceId?: string): SessionRecord[] {
      const rows = (workspaceId ? listByWorkspaceStmt : listStmt).all(
        ...(workspaceId ? [workspaceId] : []),
      ) as unknown as SessionRow[];
      return rows.map(toSession);
    },

    delete(id: string): void {
      deleteStmt.run(id);
    },

    touch(id: string, updatedAt = Date.now()): void {
      touchStmt.run(updatedAt, id);
    },

    updateModel(id: string, provider: string, modelId: string): void {
      updateModelStmt.run(provider, modelId, Date.now(), id);
    },

    rename(id: string, name: string): void {
      renameStmt.run(name, Date.now(), id);
    },

    updateSystemPrompt(id: string, systemPrompt: string): void {
      updateSystemPromptStmt.run(systemPrompt, id);
    },

    getGoal(id: string): GoalInfo | undefined {
      const row = getStmt.get(id) as unknown as SessionRow | undefined;
      return row ? toGoal(row) : undefined;
    },

    setGoal(id: string, text: string, maxIterations: number): void {
      setGoalStmt.run(text, maxIterations, Date.now(), id);
    },

    updateGoal(id: string, patch: GoalUpdate): void {
      const current = getStmt.get(id) as unknown as SessionRow | undefined;
      if (
        !current || current.goal_text === null ||
        current.goal_text === undefined
      ) {
        return;
      }
      const next: GoalInfo = {
        text: current.goal_text,
        iteration: patch.iteration ?? current.goal_iteration ?? 0,
        maxIterations: current.goal_max_iterations ?? 10,
        status: patch.status ?? (
          current.goal_status === "judging" ? "judging" : "active"
        ),
        ...(patch.lastReason !== undefined
          ? (patch.lastReason === null ? {} : { lastReason: patch.lastReason })
          : (current.goal_last_reason
            ? { lastReason: current.goal_last_reason }
            : {})),
      };
      db.db.prepare(`
        UPDATE sessions
        SET goal_iteration = ?, goal_max_iterations = ?,
            goal_status = ?, goal_last_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.iteration,
        next.maxIterations,
        next.status,
        next.lastReason ?? null,
        Date.now(),
        id,
      );
    },

    clearGoal(id: string): void {
      clearGoalStmt.run(Date.now(), id);
    },
  };
}
