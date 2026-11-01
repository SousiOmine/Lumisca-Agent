import type { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";

/**
 * The assistants of stella mode.
 *
 * stella's premise is one ongoing conversation with one agent, so the
 * thing a user picks is not a session — it is WHO they are talking to. An
 * agent is a name and the role it works from; its conversation is the
 * `sessions` row that points at it, and that row carries the whole transcript
 * (so compaction, rewind and the event stream work unchanged).
 *
 * This is Terasuma's Tera, minus everything that does not earn its place:
 * no separate workspace folder (stella's files live in the machine, not per
 * agent) and no per-agent Discord webhook.
 *
 * An agent also has an icon — the picture the user picked for it — but that
 * is presentation, not identity: it is stored as a name the icon store
 * generated (stella/icons.ts) and never reaches the model.
 *
 * Two texts describe the agent, and they have different authors:
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
  /** The picture the user picked for this agent: a name the icon store
   * generated (see stella/icons.ts), or "" when there is none. The client
   * appends it to `/api/stella/agents/:id/icon/`; an agent without one is
   * drawn as its initial on a colour derived from its id
   * (shared/agent-avatar.ts). Never part of the model's context: it is how
   * the agent looks, not who it is. */
  icon: string;
  createdAt: number;
  updatedAt: number;
}

/** The longest accepted name / role. A prompt section is not a document:
 * these are shown in a sidebar row and read on every turn. */
export const MAX_AGENT_NAME_CHARS = 60;
export const MAX_AGENT_ROLE_CHARS = 2_000;
/** What an unnamed agent is called. The name is the sidebar's label and the
 * opening of its prompt ("You are …"), so it cannot be empty — but choosing
 * it is not a decision worth blocking the user on: an agent can be made first
 * and named later, or never. */
export const DEFAULT_AGENT_NAME = "Agent";
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
  /** Point the agent at a different icon (a name the icon store generated),
   * or clear it with "". The store owns the file; this only records which
   * one the row shows. */
  setIcon(id: string, name: string): void;
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
  icon?: string | null;
  created_at: number;
  updated_at: number;
}

function toAgent(row: AgentRow): StellaAgent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    identity: row.identity ?? "",
    icon: row.icon ?? "",
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
  // Both fields are the user's to fill in or leave alone: creating an agent
  // is how someone starts talking to one, and a form that refuses to submit
  // until two free-text answers are written is a wall in front of that. An
  // empty name becomes the default label (the row and the prompt need SOME
  // name); an empty role just means this agent works from the app's own
  // instructions instead of a persona (see buildStellaSystemPrompt).
  const name = input.name.trim() || DEFAULT_AGENT_NAME;
  if (name.length > MAX_AGENT_NAME_CHARS) {
    throw new Error(
      `The agent's name must be at most ${MAX_AGENT_NAME_CHARS} characters ` +
        `(got ${name.length}).`,
    );
  }
  const role = input.role.trim();
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
    // `created_at` then `rowid` make the order total: two agents created in
    // the same millisecond would otherwise come back in whatever order
    // SQLite felt like (and the sidebar would reshuffle between reads).
    "SELECT * FROM stella_agents " +
      "ORDER BY updated_at DESC, created_at DESC, rowid DESC",
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
  const setIconStmt = db.db.prepare(
    // `updated_at` is deliberately left alone: it orders the sidebar by "who
    // was talked to last" (list/touch), so picking a picture must not move a
    // row to the top or change which agent a fresh screen opens.
    "UPDATE stella_agents SET icon = ? WHERE id = ?",
  );
  const deleteStmt = db.db.prepare("DELETE FROM stella_agents WHERE id = ?");
  // "Most recently used" has to be a strict order, and a millisecond clock is
  // too coarse for it: creating two agents and touching one inside the same
  // millisecond would leave the tie for SQLite to break (it picks the last
  // row, i.e. the wrong agent). Adding 1 over the current maximum keeps the
  // touched row on top whatever the clock resolution is.
  const touchStmt = db.db.prepare(
    "UPDATE stella_agents SET updated_at = " +
      "MAX(?, (SELECT COALESCE(MAX(updated_at), 0) + 1 FROM stella_agents)) " +
      "WHERE id = ?",
  );
  const latestStmt = db.db.prepare(
    "SELECT * FROM stella_agents " +
      "ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1",
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
      return {
        id,
        name,
        role,
        identity: "",
        icon: "",
        createdAt: now,
        updatedAt: now,
      };
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

    setIcon(id: string, name: string): void {
      // The caller (core) has already stored the file and knows the name is
      // one this build generated; an unknown agent still fails loudly,
      // because a picture recorded for nobody would be a file nothing shows.
      const result = setIconStmt.run(name, id);
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
