import type { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";
import type { StellaAgentSummaryBase } from "../shared/stella-preview.ts";

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
 * So is its model: `model` records which model the user wants this agent's
 * conversation to run on (null = the app's default). It is stored on the
 * agent rather than only on the conversation because the conversation may
 * not exist yet, and a user choosing a model in the edit dialog must not
 * have to open the conversation first. The conversation row is still what
 * the run reads — the two are written together.
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
/** The row the store keeps: what a sidebar row needs (see
 * shared/stella-preview.ts) plus the agent's own text and timestamps. */
export interface StellaAgent extends StellaAgentSummaryBase {
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
  /** The model this agent's conversation runs on, or null for the app's
   * default model. The conversation row still carries the pair it actually
   * runs on (`sessions.model_provider`/`model_id`) — this is the user's
   * choice for that conversation, written by the edit dialog and applied to
   * the row in the same call (see LumiscaCore.updateStellaAgent). */
  model: { provider: string; modelId: string } | null;
  /** When the app started this agent's setup turn (see onboarding.ts), or
   * null when it has not started yet. It is the once-only guard: opening the
   * conversation starts the turn only while this is null, and the turn is
   * not the user's message, so nothing else in the transcript can tell
   * "never set up" from "set up and said nothing". */
  onboardedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The longest accepted name / role. The name is a sidebar row; the role is
 * the agent's system prompt, and a system prompt may be a full brief — the
 * job, the tone, what to check and when to ask — so its limit is set by what
 * a model can read on every turn, not by what fits on a line. */
export const MAX_AGENT_NAME_CHARS = 60;
export const MAX_AGENT_ROLE_CHARS = 20_000;
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
  /** Replace the agent's name, its picture and/or its model, in one row
   * write. All three are presentation (see the module comment), so none
   * moves the row: a rename and a new picture are not "talking to" the
   * agent, and `updated_at` is what orders the sidebar.
   *
   * `icon` is a name the icon store generated (stella/icons.ts), or "" for
   * no picture; omitted leaves the current one. `model` omitted leaves the
   * current choice alone, null returns the agent to the app's default model,
   * and a pair replaces it. The name is trimmed and length-checked here, so
   * the route, the tool and every other caller share one rule. An unknown id
   * fails loudly: a picture or a name recorded for nobody is a file nothing
   * shows. */
  update(
    id: string,
    patch: {
      name?: string;
      icon?: string;
      model?: { provider: string; modelId: string } | null;
    },
  ): void;
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
  /** Claim the right to start the setup turn. True for exactly one caller:
   * the update only matches while `onboarded_at` is still NULL, so two
   * clients opening the same conversation at once cannot both start it.
   * An unknown id is false (there is no row to set up). */
  markOnboarded(id: string): boolean;
  /** Forget that the setup turn ran, so the next open starts it again (the
   * sidebar's "設定をやり直す"). */
  clearOnboarded(id: string): void;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  identity?: string | null;
  icon?: string | null;
  model_provider?: string | null;
  model_id?: string | null;
  onboarded_at?: number | null;
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
    // Both columns or neither: a half-written pair is not a model, and a
    // conversation built from it would fail to open.
    model:
      row.model_provider && row.model_id
        ? { provider: row.model_provider, modelId: row.model_id }
        : null,
    onboardedAt: row.onboarded_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize and validate what a caller (or the agent-creation tool) passes.
 * Throws with a sentence the model can act on — never silently truncates. */
export function normalizeAgentInput(input: { name: string; role: string }): {
  name: string;
  role: string;
} {
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

/**
 * Normalize the model an agent's conversation should run on.
 *
 * `null` means "the app's default model" and passes through: clearing the
 * choice is a real choice, and it must not become an empty provider id that
 * the conversation would then fail to open with. A pair is trimmed and both
 * halves are required — `{provider: "x", modelId: ""}` describes a request,
 * not a model. Whether the pair names a model the catalog HAS is checked by
 * the caller that can read the catalog (LumiscaCore.updateStellaAgent); this
 * function only sees a string.
 */
export function normalizeAgentModel(
  model: { provider: string; modelId: string } | null,
): { provider: string; modelId: string } | null {
  if (model === null) return null;
  const provider = model.provider.trim();
  const modelId = model.modelId.trim();
  if (provider.length === 0 || modelId.length === 0) {
    throw new CoreError(
      "A model needs both a provider and a model id.",
      "invalid",
    );
  }
  return { provider, modelId };
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
    // One statement for all three: they travel together from the edit
    // dialog, and a rename that landed while the picture failed would leave
    // the user with half of what they asked for. `updated_at` is
    // deliberately absent — see AgentRepo.update.
    "UPDATE stella_agents SET name = ?, icon = ?, model_provider = ?, " +
      "model_id = ? WHERE id = ?",
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
  // `updated_at` is deliberately absent: setting the agent up is not talking
  // to it, and the sidebar orders rows by when they last spoke.
  const markOnboardedStmt = db.db.prepare(
    "UPDATE stella_agents SET onboarded_at = ? " +
      "WHERE id = ? AND onboarded_at IS NULL",
  );
  const clearOnboardedStmt = db.db.prepare(
    "UPDATE stella_agents SET onboarded_at = NULL WHERE id = ?",
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
        model: null,
        onboardedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },

    update(id: string, patch): void {
      // The current row is read first: a patch names only what changed, and
      // one statement writes all three fields (see updateStmt).
      const current = this.get(id);
      if (current === undefined) {
        throw new CoreError(`Agent not found: ${id}`, "not_found");
      }
      const name =
        patch.name === undefined
          ? current.name
          : normalizeAgentName(patch.name);
      const icon = patch.icon ?? current.icon;
      const model =
        patch.model === undefined
          ? current.model
          : normalizeAgentModel(patch.model);
      // A patch that changes nothing is not an error, and it is also not a
      // write: an edit dialog opened and saved untouched must not touch the
      // row (a future column would otherwise be stamped by a no-op).
      if (
        name === current.name &&
        icon === current.icon &&
        model?.provider === current.model?.provider &&
        model?.modelId === current.model?.modelId
      ) {
        return;
      }
      updateStmt.run(
        name,
        icon,
        model?.provider ?? null,
        model?.modelId ?? null,
        id,
      );
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

    markOnboarded(id: string): boolean {
      return Number(markOnboardedStmt.run(Date.now(), id).changes) > 0;
    },

    clearOnboarded(id: string): void {
      clearOnboardedStmt.run(id);
    },
  };
}
