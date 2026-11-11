import type { ClientEvent } from "../domain/event.ts";
import { CoreError } from "../errors.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { SessionRepo } from "../session/repo.ts";
import type { Locale, StellaAgentSummary } from "../shared/mod.ts";
import { translate } from "../shared/mod.ts";
import type { AgentRepo, StellaAgent } from "../stella/agents.ts";
import { DEFAULT_AGENT_NAME, normalizeAgentName } from "../stella/agents.ts";
import type { AgentIconStore } from "../stella/icons.ts";
import { latestPreview } from "../stella/previews.ts";

/**
 * The agents of stella mode: the rows in the sidebar, and what each looks
 * like.
 *
 * Extracted from LumiscaCore, where 235 lines of the facade were about names,
 * pictures and duplicate-NAME rules — none of which the facade needs to know
 * to open a conversation. What stays there is the conversation itself
 * (getOrCreateStellaSession and the machine), which is a different question.
 *
 * The two naming rules live here because they are the only reason a create or
 * a rename can fail: a name another agent already has (compared
 * case-insensitively — "Researcher" and "researcher" are one row in the
 * sidebar) and a name nobody chose (the default, then "Agent 2", …).
 */
export class StellaAgentService {
  constructor(
    private readonly deps: {
      agents: AgentRepo;
      icons: AgentIconStore;
      sessions: SessionRepo;
      messages: MessageRepo;
      /** Remove a conversation and everything it published (the same entry
       * point the session API uses, so an agent's files do not outlive it). */
      deleteSession(id: string): Promise<void>;
      language(): Locale;
      /** Publish an event to every frontend listener. */
      emit(event: ClientEvent): void;
    },
  ) {}

  listStellaAgents(): StellaAgent[] {
    return this.deps.agents.list();
  }

  /**
   * The sidebar's rows: the agents, each with what its conversation last
   * said.
   *
   * The preview is read from the store per agent (see stella/previews.ts) and
   * only for THIS list: a list of agents that says who they are but not what
   * they said is the thing a message app does not have. The read is bounded
   * (a handful of rows per agent regardless of how long the conversation is),
   * so a refresh costs the same after a year of talking as on the first day.
   *
   * Order is the client's (`compareAgentRows`), not this method's: the agent
   * repository answers in "most recently used" order, and the two differ the
   * moment another client — or a routine — speaks in a conversation this one
   * has not opened.
   */
  listStellaAgentSummaries(): StellaAgentSummary[] {
    return this.deps.agents.list().map((agent) => ({
      ...agent,
      preview: latestPreview(
        this.deps.messages,
        this.deps.sessions.getByAgent(agent.id)?.id,
      ),
    }));
  }

  /**
   * Make sure the installation has someone to talk to, and return the agent a
   * client should open.
   *
   * A first run used to greet the user with an empty sidebar and a disabled
   * composer: stella's premise is a conversation, so "you have nobody to talk
   * to yet" is a wall in front of the one thing the mode is for. The starter
   * agent is therefore created by the server, once — its name and role come
   * from the message catalogue (the role is a sentence the user would have
   * written anyway, and it is editable only by recreating the agent, which is
   * why it is phrased as a general-purpose one).
   *
   * It is created on the FIRST READ and then never again: an empty list is
   * exactly what a first run looks like, and a user who deliberately deleted
   * every agent still gets one back the next time they open stella mode (the
   * alternative — an empty mode with no way in — is the state this exists to
   * prevent). The check is the list itself, so nothing has to be remembered
   * separately.
   */
  ensureStellaAgent(): StellaAgent {
    const existing = this.deps.agents.latest();
    if (existing !== undefined) return existing;
    return this.deps.agents.create({
      name: translate(this.deps.language(), "chat.stella.agents.starterName"),
      role: translate(this.deps.language(), "chat.stella.agents.starterRole"),
    });
  }

  /** One agent by id, or undefined when it does not exist. */
  getStellaAgent(id: string): StellaAgent | undefined {
    return this.deps.agents.get(id);
  }

  /** Claim the right to start this agent's setup turn (see
   * AgentRepo.markOnboarded): true for exactly one caller. */
  markOnboarded(id: string): boolean {
    return this.deps.agents.markOnboarded(id);
  }

  /** Forget the setup turn, so the next open starts it again. */
  clearOnboarded(id: string): void {
    this.deps.agents.clearOnboarded(id);
  }

  /** Create an agent from a name and the role it works from.
   *
   * A name that is already taken is refused (compared case-insensitively:
   * "Researcher" and "researcher" would be two indistinguishable rows in the
   * sidebar) — but a name the user did not choose does not join that
   * comparison. Someone who leaves the field empty gets the default label
   * with a number after it ("Agent 2"), never a "that name is taken" for a
   * name they never wrote. */
  createStellaAgent(input: { name: string; role: string }): StellaAgent {
    const name = input.name.trim();
    if (name.length === 0) {
      return this.deps.agents.create({
        ...input,
        name: this.unusedAgentName(DEFAULT_AGENT_NAME),
      });
    }
    this.requireUnusedAgentName(name);
    return this.deps.agents.create(input);
  }

  /** Refuse a name another agent already has. `exceptId` is the agent being
   * renamed: keeping one's own name (however it is capitalized) is not a
   * conflict with itself.
   *
   * One rule for creating and renaming, because the sidebar's reason for it
   * is the same in both: two rows the user cannot tell apart. */
  private requireUnusedAgentName(name: string, exceptId?: string): void {
    const taken = this.deps.agents
      .list()
      .some(
        (agent) =>
          agent.id !== exceptId &&
          agent.name.toLowerCase() === name.toLowerCase(),
      );
    if (taken) {
      throw new CoreError(
        `An agent named "${name}" already exists. Choose another name.`,
        "conflict",
      );
    }
  }

  /** `base` ("Agent"), or the first free "Agent N" after it. Used only for a
   * name the user did not supply. */
  private unusedAgentName(base: string): string {
    const taken = new Set(
      this.deps.agents.list().map((agent) => agent.name.toLowerCase()),
    );
    if (!taken.has(base.toLowerCase())) return base;
    for (let index = 2; index < Number.MAX_SAFE_INTEGER; index++) {
      const candidate = `${base} ${index}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  /**
   * Change what an agent is CALLED, what it LOOKS like, and which model its
   * conversation runs on, then return the updated row.
   *
   * One entry point for all three because they are one act: the sidebar's
   * edit dialog saves them together, and a request that stored one but
   * refused the other would leave the user with half of what they asked for
   * (and with a dialog that has to explain which half).
   *
   * The name is validated FIRST — before a single byte is written — so a
   * taken or empty name costs nothing. Neither change touches `updated_at`:
   * it orders the sidebar by "who was talked to last", and editing an agent
   * is not talking to it (see AgentRepo.update).
   *
   * `icon` is:
   * - `undefined` → leave the picture alone;
   * - `null` → back to the initial (the file is removed);
   * - `{ bytes, extension }` → a new picture. The new file is stored first,
   *   then the row, then the old file is removed: a crash between the steps
   *   leaves an unreferenced file (the store's per-agent cap bounds how many),
   *   never a row pointing at bytes that are not there — an icon that fails
   *   to load would be a blank circle the user cannot explain.
   *
   * `extension` is the stored format (`.png`, `.jpg`, …); the route derives it
   * from what the browser reported, and the store verifies the bytes actually
   * are that format rather than trusting the name.
   *
   * `model` is `undefined` for "leave it", `null` for "the app's default
   * model", or the pair to run on. Only the ROW is written here: applying the
   * pair to the agent's conversation needs the model catalog and the running
   * conversation, which this book does not have (see
   * LumiscaCore.updateStellaAgent, its only caller).
   */
  async updateStellaAgent(
    id: string,
    patch: {
      name?: string;
      icon?: { bytes: Uint8Array; extension: string } | null;
      model?: { provider: string; modelId: string } | null;
    },
  ): Promise<StellaAgent> {
    const agent = this.deps.agents.get(id);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    const name =
      patch.name === undefined ? undefined : normalizeAgentName(patch.name);
    if (name !== undefined) this.requireUnusedAgentName(name, id);
    const model = patch.model;
    const fields = {
      ...(name === undefined ? {} : { name }),
      ...(model === undefined ? {} : { model }),
    };

    // Back to the initial: the row stops naming the file, then the file goes.
    // Nothing else in this patch can fail after that. The row is written even
    // when the agent had no picture, because the same patch may carry a name
    // or a model (a no-op write is skipped by AgentRepo.update).
    if (patch.icon === null) {
      this.deps.agents.update(id, { ...fields, icon: "" });
      await this.deps.icons.remove(id, agent.icon);
    } else if (patch.icon !== undefined) {
      const stored = await this.deps.icons.put(
        id,
        patch.icon.bytes,
        patch.icon.extension,
      );
      try {
        // Name, picture and model in one row write: the dialog sent one
        // request, so the row changes once.
        this.deps.agents.update(id, { ...fields, icon: stored });
      } catch (error) {
        // The row refused the name (the agent was deleted while the bytes
        // were written): the file has no owner now, so it goes with the
        // failure.
        await this.deps.icons.remove(id, stored);
        throw error;
      }
      if (agent.icon !== "" && agent.icon !== stored) {
        await this.deps.icons.remove(id, agent.icon);
      }
    } else if (name !== undefined || model !== undefined) {
      this.deps.agents.update(id, fields);
    }

    const updated = this.deps.agents.get(id);
    if (updated === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    return updated;
  }

  /** The icon file an agent's picture names, with the content type to serve
   * it as (`GET /api/stella/agents/:id/icon/:name`). Undefined for a name the
   * store did not generate or a file that is gone. The store validates the
   * name, so a caller cannot ask for anything outside the agent's own
   * directory. */
  resolveStellaAgentIcon(
    id: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.deps.icons.resolve(id, name);
  }

  /**
   * Delete an agent and its conversation.
   *
   * The transcript goes with it: `sessions.agent_id` has no cascade (the row
   * is deleted explicitly below), so deleting an agent means stopping its
   * session first and then dropping both rows — an orphaned session would be
   * invisible in every list while still holding its messages.
   */
  async deleteStellaAgent(id: string): Promise<void> {
    const session = this.deps.sessions.getByAgent(id);
    if (session !== undefined) await this.deps.deleteSession(session.id);
    this.deps.agents.delete(id);
    // The picture belongs to the agent: once the row is gone nothing can
    // name it, and the store's directory would outlive every reference.
    await this.deps.icons.deleteAgent(id);
  }

  /**
   * The conversation with one agent, created on first use.
   *
   * stella has no session concept in the UI: an agent has ONE conversation,
   * which grows for as long as the agent exists. Under the hood it is an
   * ordinary session row (flagged `stella`, carrying `agentId`), so the
   * transcript store, context compaction, rewind and the event stream work
   * unchanged — the alternative would be a second, parallel implementation of
   * all four.
   */
}
