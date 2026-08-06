import type { LumiscaDb } from "../db/mod.ts";
import type { SessionInfo } from "../types/session.ts";

export interface SessionRecord extends SessionInfo {}

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
}

function toSession(row: {
  id: string;
  workspace_id: string;
  name: string;
  model_provider: string;
  model_id: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
}): SessionRecord {
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
      const row = getStmt.get(id) as Parameters<typeof toSession>[0] | undefined;
      return row ? toSession(row) : undefined;
    },

    list(workspaceId?: string): SessionRecord[] {
      const rows = (workspaceId ? listByWorkspaceStmt : listStmt).all(
        ...(workspaceId ? [workspaceId] : []),
      ) as Array<Parameters<typeof toSession>[0]>;
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
  };
}
