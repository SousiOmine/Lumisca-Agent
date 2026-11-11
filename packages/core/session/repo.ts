import type { LumiscaDb } from "../db/mod.ts";
import type { SessionInfo } from "../domain/session.ts";

export type SessionRecord = SessionInfo;

export interface SessionRepo {
  create(
    input: Omit<SessionInfo, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: number;
      updatedAt?: number;
      /** True for a stella agent's conversation (see SessionInfo). */
      stella?: boolean;
      /** The stella agent this conversation belongs to. */
      agentId?: string;
    },
  ): SessionRecord;
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  /** Every row, stella conversations included. For work that must reach a
   * conversation the user never sees in a list — an MCP sign-in reconnecting
   * the sessions that use the server, which stella's own conversation needs
   * as much as any other. `list()` stays the UI's list: stella has no
   * session, so it must not appear there. */
  listEvery(workspaceId?: string): SessionRecord[];
  /** stella mode's single conversation row, or undefined before the first
   * one is created. Never part of `list()`: stella has no session list. */
  /** The conversation belonging to one stella agent, if it has been started. */
  getByAgent(agentId: string): SessionRecord | undefined;
  delete(id: string): void;
  touch(id: string, updatedAt?: number): void;
  updateModel(id: string, provider: string, modelId: string): void;
  rename(id: string, name: string): void;
  updateSystemPrompt(id: string, systemPrompt: string): void;
}

interface SessionRow {
  stella?: number;
  agent_id?: string | null;
  /** The agent's name, joined for a stella conversation (see toSession). */
  agent_name?: string | null;
  id: string;
  workspace_id: string;
  name: string;
  model_provider: string;
  model_id: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
}

function toSession(row: SessionRow): SessionRecord {
  return {
    ...(row.stella === 1 ? { stella: true } : {}),
    ...(row.agent_id !== undefined && row.agent_id !== null
      ? { agentId: row.agent_id }
      : {}),
    id: row.id,
    workspaceId: row.workspace_id,
    // A stella conversation has no name of its own: the agent is named, and
    // the conversation is that agent talking. The row's own `name` is empty
    // there (see StellaMachineService.getOrCreateStellaSession), so the name
    // is read from the agent on every read — a copy kept on the row is what
    // once left a renamed agent's conversation answering to its old name.
    name: row.agent_name ?? row.name,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    systemPrompt: row.system_prompt ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every session read goes through this. A stella conversation's name is its
 * agent's (see toSession), so the agent's name rides along as `agent_name`;
 * for every other session the join finds nothing and the row's own name is
 * used. An index lookup on the primary key, so a read costs one extra probe
 * whatever the table's size. */
const SELECT_SESSIONS =
  "SELECT s.*, a.name AS agent_name FROM sessions s " +
  "LEFT JOIN stella_agents a ON a.id = s.agent_id";

export function createSessionRepo(db: LumiscaDb): SessionRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, system_prompt, created_at, updated_at, stella, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getByAgentStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.agent_id = ?`,
  );
  const getStmt = db.db.prepare(`${SELECT_SESSIONS} WHERE s.id = ?`);
  // stella's row is not a session: it is excluded everywhere a session list
  // is built, so no client ever offers to open, close or delete it.
  const listStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.stella = 0 ORDER BY s.updated_at DESC`,
  );
  const listByWorkspaceStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.workspace_id = ? AND s.stella = 0 ` +
      "ORDER BY s.updated_at DESC",
  );
  // Everything, stella included (see SessionRepo.listEvery).
  const listEveryStmt = db.db.prepare(
    `${SELECT_SESSIONS} ORDER BY s.updated_at DESC`,
  );
  const listEveryByWorkspaceStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.workspace_id = ? ORDER BY s.updated_at DESC`,
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

  return {
    create(input): SessionRecord {
      const id = input.id ?? crypto.randomUUID();
      const createdAt = input.createdAt ?? Date.now();
      const updatedAt = input.updatedAt ?? createdAt;
      const stella = input.stella === true;
      insertStmt.run(
        id,
        input.workspaceId,
        input.name,
        input.modelProvider,
        input.modelId,
        input.systemPrompt ?? null,
        createdAt,
        updatedAt,
        stella ? 1 : 0,
        input.agentId ?? null,
      );
      // Read the row back instead of assembling the record here: a stella
      // conversation's name comes from its agent (see toSession), and a
      // second hand-written mapping would be a second answer to "what is
      // this session" that can drift from the one every other read gives.
      const row = getStmt.get(id) as unknown as SessionRow;
      return toSession(row);
    },

    getByAgent(agentId: string): SessionRecord | undefined {
      const row = getByAgentStmt.get(agentId) as unknown as
        | SessionRow
        | undefined;
      return row ? toSession(row) : undefined;
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

    listEvery(workspaceId?: string): SessionRecord[] {
      const rows = (workspaceId ? listEveryByWorkspaceStmt : listEveryStmt).all(
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
  };
}
