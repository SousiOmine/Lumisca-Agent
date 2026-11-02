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
 * Its NAME is presentation too: it labels the sidebar row and the
 * conversation's header, and nothing else. The model is never told it (see
 * buildStellaSystemPrompt), which is what makes renaming an agent something
 * the user can do at any time: no system prompt holds a copy of the old one,
 * and no cached prefix has to be thrown away to change it.
 *
 * Two texts describe the agent, and they have different authors:
 * `role` is what the USER wrote when the agent was created (and never
 * changes), and `identity` is what the AGENT writes about itself with the
 * `identity` tool. Keeping them apart is what lets an agent learn its job
 * without rewriting the instruction it was given.
 */
export interface StellaAgent {
  id: string;
  /** The label the user gave it: the sidebar row and the conversation's
   * header, and nothing the model reads. Renaming is therefore a display
   * change — see the module comment. */
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
/** What an unnamed agent is called. The name is the sidebar's label, so it
 * cannot be empty — but choosing it is not a decision worth blocking the
 * user on: an agent can be made first and named later, or never. */
export const DEFAULT_AGENT_NAME = "Agent";
/** The longest identity. It is republished whenever it changes and read on
 * every run after that, so it stays a short note rather than a document. */
export const MAX_AGENT_IDENTITY_CHARS = 4_000;

export interface AgentRepo {
  list(): StellaAgent[];
  get(id: string): StellaAgent | undefined;
  create(input: { name: string; role: string; id?: string }): StellaAgent;
  /** Replace the agent's name and/or its picture, in one row write. Both are
   * presentation (see the module comment), so neither moves the row: a
   * rename and a new picture are not "talking to" the agent, and `updated_at`
   * is what orders the sidebar.
   *
   * `icon` is a name the icon store generated (stella/icons.ts), or "" for
   * no picture; omitted leaves the current one. The name is trimmed and
   * length-checked here, so the route, the tool and every other caller share
   * one rule. An unknown id fails loudly: a picture or a name recorded for
   * nobody is a file nothing shows. */
  update(id: string, patch: { name?: string; icon?: string }): void;
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
  // empty name becomes the default label (the row needs SOME name); an empty
  // role just means this agent works from the app's own instructions instead
  // of a persona (see buildStellaSystemPrompt).
  const name = input.name.trim() || DEFAULT_AGENT_NAME;
  if (name.length > MAX_AGENT_NAME_CHARS) {
    throw new CoreError(
      `The agent's name must be at most ${MAX_AGENT_NAME_CHARS} characters ` +
        `(got ${name.length}).`,
      "invalid",
    );
  }
  const role = input.role.trim();
  if (role.length > MAX_AGENT_ROLE_CHARS) {
    throw new CoreError(
      `The agent's role must be at most ${MAX_AGENT_ROLE_CHARS} characters ` +
        `(got ${role.length}).`,
      "invalid",
    );
  }
  return { name, role };
}

/**
 * Normalize and validate a name that is replacing an existing one.
 *
 * A different rule from {@link normalizeAgentInput} in the one way that
 * matters: an EMPTY name is refused rather than replaced by the default. A
 * user who cleared the field did not ask to be given "Agent" — they cleared
 * it, and a rename that quietly invented a name would be a change they did
 * not make (and would read as the edit having failed halfway).
 */
export function normalizeAgentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new CoreError("The agent's name must not be empty.", "invalid");
  }
  if (trimmed.length > MAX_AGENT_NAME_CHARS) {
    throw new CoreError(
      `The agent's name must be at most ${MAX_AGENT_NAME_CHARS} characters ` +
        `(got ${trimmed.length}).`,
      "invalid",
    );
  }
  return trimmed;
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
  const writeIdentityStmt = db.db.prepare(
    "UPDATE stella_agents SET identity = ?, updated_at = ? WHERE id = ?",
  );
  const updateStmt = db.db.prepare(
    // One statement for both display fields: the two travel together from
    // the edit dialog, and a rename that landed while the picture failed
    // would leave the user with half of what they asked for. `updated_at` is
    // deliberately absent — see AgentRepo.update.
    "UPDATE stella_agents SET name = ?, icon = ? WHERE id = ?",
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

    update(id: string, patch): void {
      // The current row is read first: a patch names only what changed, and
      // one statement writes both fields (see updateStmt).
      const current = this.get(id);
      if (current === undefined) {
        throw new CoreError(`Agent not found: ${id}`, "not_found");
      }
      const name = patch.name === undefined
        ? current.name
        : normalizeAgentName(patch.name);
      const icon = patch.icon ?? current.icon;
      // A patch that changes nothing is not an error, and it is also not a
      // write: an edit dialog opened and saved untouched must not touch the
      // row (a future column would otherwise be stamped by a no-op).
      if (name === current.name && icon === current.icon) return;
      updateStmt.run(name, icon, id);
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
