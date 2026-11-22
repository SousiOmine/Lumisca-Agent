import type { LumiscaDb } from "../db/mod.ts";
import type { SessionInfo } from "../domain/session.ts";

export type SessionRecord = SessionInfo;

/** A new main agent's id: 32 lowercase hex characters.
 *
 * Opaque: nothing parses it, nothing shows it, and it is not derived from
 * the session — a row whose id copies another table's id is a second answer
 * to "which agent is this". The migration's backfill generates the same
 * shape with `randomblob`, so rows written before and after this code agree.
 * A sub-agent's id is different: it is minted by AgentRepo and shown. */
function newMainAgentId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export interface SessionRepo {
  create(
    input: Omit<
      SessionInfo,
      "id" | "createdAt" | "updatedAt" | "mainAgentId"
    > & {
      id?: string;
      createdAt?: number;
      updatedAt?: number;
      /** The stella persona this conversation belongs to. Having one is what
       * makes the row a stella conversation (see SessionInfo.stella): the
       * flag is derived, never stored. */
      personaId?: string;
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
  /** The conversation belonging to one stella persona, if it has been
   * started. Never part of `list()`: stella has no session list. */
  getByPersona(personaId: string): SessionRecord | undefined;
  delete(id: string): void;
  touch(id: string, updatedAt?: number): void;
  updateModel(id: string, provider: string, modelId: string): void;
  rename(id: string, name: string): void;
  updateSystemPrompt(id: string, systemPrompt: string): void;
}

interface SessionRow {
  /** The session's main agent, joined from `agents` (see toSession). */
  main_agent_id: string | null;
  persona_id?: string | null;
  /** The persona's name, joined for a stella conversation (see toSession). */
  persona_name?: string | null;
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
  // Every session is created with its main agent in the same transaction
  // (see create), and the migration stamped the rows that came before it.
  // A missing one is a row this code did not write: a transcript with no
  // owner would silently read as empty, so fail instead.
  if (row.main_agent_id === null) {
    throw new Error(`session ${row.id} has no main agent`);
  }
  return {
    // One fact, one column: belonging to a persona IS being a stella
    // conversation. `stella` stays on SessionInfo for its readers, derived
    // here so no write can make the two disagree.
    ...(row.persona_id !== undefined && row.persona_id !== null
      ? { stella: true, personaId: row.persona_id }
      : {}),
    id: row.id,
    mainAgentId: row.main_agent_id,
    workspaceId: row.workspace_id,
    // A stella conversation has no name of its own: the persona is named, and
    // the conversation is that persona talking. The row's own `name` is empty
    // there (see StellaMachineService.getOrCreateStellaSession), so the name
    // is read from the persona on every read — a copy kept on the row is what
    // once left a renamed persona's conversation answering to its old name.
    name: row.persona_name ?? row.name,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    systemPrompt: row.system_prompt ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every session read goes through this. A session's transcript belongs to
 * its main agent and a stella conversation's name to its persona, so both
 * ride along as a join; each is a primary-key lookup, so a read costs two
 * extra probes whatever the table's size. */
const SELECT_SESSIONS =
  "SELECT s.*, p.name AS persona_name, m.id AS main_agent_id " +
  "FROM sessions s " +
  "LEFT JOIN stella_agents p ON p.id = s.persona_id " +
  "LEFT JOIN agents m ON m.session_id = s.id AND m.kind = 'main'";

export function createSessionRepo(db: LumiscaDb): SessionRepo {
  const insertStmt = db.db.prepare(`
    INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, system_prompt, created_at, updated_at, persona_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMainAgentStmt = db.db.prepare(
    "INSERT INTO agents (id, session_id, parent_id, kind, depth, created_at) " +
      "VALUES (?, ?, NULL, 'main', 0, ?)",
  );
  const getByPersonaStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.persona_id = ?`,
  );
  const getStmt = db.db.prepare(`${SELECT_SESSIONS} WHERE s.id = ?`);
  // stella's row is not a session: a conversation that belongs to a persona
  // is excluded everywhere a session list is built, so no client ever offers
  // to open, close or delete it.
  const listStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.persona_id IS NULL ORDER BY s.updated_at DESC`,
  );
  const listByWorkspaceStmt = db.db.prepare(
    `${SELECT_SESSIONS} WHERE s.workspace_id = ? AND s.persona_id IS NULL ` +
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
      // The session and its main agent are one fact: a session without one
      // could never write a message (the messages foreign key needs it), so
      // the two rows are written together or not at all.
      const mainAgentId = newMainAgentId();
      db.transaction(() => {
        insertStmt.run(
          id,
          input.workspaceId,
          input.name,
          input.modelProvider,
          input.modelId,
          input.systemPrompt ?? null,
          createdAt,
          updatedAt,
          input.personaId ?? null,
        );
        insertMainAgentStmt.run(mainAgentId, id, createdAt);
      });
      // Read the row back instead of assembling the record here: a stella
      // conversation's name comes from its persona (see toSession), and a
      // second hand-written mapping would be a second answer to "what is
      // this session" that can drift from the one every other read gives.
      const row = getStmt.get(id) as unknown as SessionRow;
      return toSession(row);
    },

    getByPersona(personaId: string): SessionRecord | undefined {
      const row = getByPersonaStmt.get(personaId) as unknown as
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
