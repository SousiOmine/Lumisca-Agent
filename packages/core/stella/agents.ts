import type { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";

/**
 * The assistants of stella mode.
 *
 * stella's premise is one ongoing conversation with one counterpart, so the
 * thing a user picks is not a session — it is WHO they are talking to. An
 * agent is a name and the role it works from; its conversation is the
 * `sessions` row that points at it, and that row carries the whole transcript
 * (so compaction, rewind and the event stream work unchanged).
 *
 * This is Terasuma's Tera, minus everything that does not earn its place:
 * no separate workspace folder (stella's files live in the machine, not per
 * agent) and no per-agent Discord webhook.
 *
 * Two texts describe the counterpart, and they have different authors:
 * `role` is what the USER wrote when the agent was created (and never
 * changes), and `identity` is what the AGENT writes about itself with the
 * `identity` tool. Keeping them apart is what lets an agent learn its job
 * without rewriting the instruction it was given.
 */
export interface StellaAgent {
  id: string;
  /** Shown in the sidebar and in the conversation's header. */
  name: string;
  /** What this agent is for, in the user's words. Goes into its system
   * prompt, so the agent knows its own job from its first turn. */
  role: string;
  /** The agent's own description of itself (its role, what it is responsible
   * for, and the knowledge the work needs), written with the `identity`
   * tool. Empty until it writes one. Published to the model as a context
   * message, so a write reaches it from the next run — never as a
   * system-prompt edit (see stella/identity.ts). */
  identity: string;
  createdAt: number;
  updatedAt: number;
}

/** The longest accepted name / role. A prompt section is not a document:
 * these are shown in a sidebar row and read on every turn. */
export const MAX_AGENT_NAME_CHARS = 60;
export const MAX_AGENT_ROLE_CHARS = 2_000;
/** The longest identity. It is republished whenever it changes and read on
 * every run after that, so it stays a short note rather than a document. */
export const MAX_AGENT_IDENTITY_CHARS = 4_000;

export interface AgentRepo {
  list(): StellaAgent[];
  get(id: string): StellaAgent | undefined;
  create(input: { name: string; role: string; id?: string }): StellaAgent;
  rename(id: string, name: string): void;
  /** Replace the agent's identity (its own text). Trimmed and length-checked
   * here, so the tool and every other caller share one rule. An empty string
   * clears it. */
  writeIdentity(id: string, content: string): void;
  delete(id: string): void;
  /** The most recently used agent, or undefined when there is none (first
   * run). The sidebar and the conversation pick it by default. */
  latest(): StellaAgent | undefined;
  /** Record that this agent's conversation was used, so `latest()` follows
   * what the user actually talks to. */
  touch(id: string): void;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  identity?: string | null;
  created_at: number;
  updated_at: number;
}

function toAgent(row: AgentRow): StellaAgent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    identity: row.identity ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize and validate what a caller (or the agent-creation tool) passes.
 * Throws with a sentence the model can act on — never silently truncates. */
export function normalizeAgentInput(input: {
  name: string;
  role: string;
}): { name: string; role: string } {
  const name = input.name.trim();
  if (name.length === 0) throw new Error("The agent's name must not be empty.");
  if (name.length > MAX_AGENT_NAME_CHARS) {
    throw new Error(
      `The agent's name must be at most ${MAX_AGENT_NAME_CHARS} characters ` +
        `(got ${name.length}).`,
    );
  }
  const role = input.role.trim();
  if (role.length === 0) {
    throw new Error(
      "The agent's role must not be empty: say what this agent is for.",
    );
  }
  if (role.length > MAX_AGENT_ROLE_CHARS) {
    throw new Error(
      `The agent's role must be at most ${MAX_AGENT_ROLE_CHARS} characters ` +
        `(got ${role.length}).`,
    );
  }
  return { name, role };
}

export function createAgentRepo(db: LumiscaDb): AgentRepo {
  const listStmt = db.db.prepare(
    "SELECT * FROM stella_agents ORDER BY updated_at DESC, created_at DESC",
  );
  const getStmt = db.db.prepare("SELECT * FROM stella_agents WHERE id = ?");
  const insertStmt = db.db.prepare(
    "INSERT INTO stella_agents (id, name, role, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  const renameStmt = db.db.prepare(
    "UPDATE stella_agents SET name = ?, updated_at = ? WHERE id = ?",
  );
  const writeIdentityStmt = db.db.prepare(
    "UPDATE stella_agents SET identity = ?, updated_at = ? WHERE id = ?",
  );
  const deleteStmt = db.db.prepare("DELETE FROM stella_agents WHERE id = ?");
  const touchStmt = db.db.prepare(
    "UPDATE stella_agents SET updated_at = ? WHERE id = ?",
  );
  const latestStmt = db.db.prepare(
    "SELECT * FROM stella_agents ORDER BY updated_at DESC, created_at DESC LIMIT 1",
  );

  return {
    list(): StellaAgent[] {
      return (listStmt.all() as unknown as AgentRow[]).map(toAgent);
    },

    get(id: string): StellaAgent | undefined {
      const row = getStmt.get(id) as unknown as AgentRow | undefined;
      return row ? toAgent(row) : undefined;
    },

    create(input): StellaAgent {
      const { name, role } = normalizeAgentInput(input);
      const id = input.id ?? crypto.randomUUID();
      const now = Date.now();
      insertStmt.run(id, name, role, now, now);
      return { id, name, role, identity: "", createdAt: now, updatedAt: now };
    },

    rename(id: string, name: string): void {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error("The agent's name must not be empty.");
      }
      renameStmt.run(trimmed, Date.now(), id);
    },

    writeIdentity(id: string, content: string): void {
      const text = content.trim();
      if (text.length > MAX_AGENT_IDENTITY_CHARS) {
        throw new CoreError(
          `Your identity must be at most ${MAX_AGENT_IDENTITY_CHARS} ` +
            `characters (got ${text.length}). Shorten it and try again.`,
          "invalid",
        );
      }
      // The row is what the provider reads, so a write for an agent that no
      // longer exists fails instead of quietly doing nothing.
      const result = writeIdentityStmt.run(text, Date.now(), id);
      if (Number(result.changes) === 0) {
        throw new CoreError(`Agent not found: ${id}`, "not_found");
      }
    },

    delete(id: string): void {
      deleteStmt.run(id);
    },

    latest(): StellaAgent | undefined {
      const row = latestStmt.get() as unknown as AgentRow | undefined;
      return row ? toAgent(row) : undefined;
    },

    touch(id: string): void {
      touchStmt.run(Date.now(), id);
    },
  };
}
