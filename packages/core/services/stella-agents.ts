import type { ClientEvent } from "../domain/event.ts";
import type { SessionInfo } from "../domain/session.ts";
import { CoreError } from "../errors.ts";
import { isThinkingLevel } from "../models/thinking.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { SessionRepo } from "../session/repo.ts";
import type {
  Locale,
  StellaAgentSummary,
  ThinkingLevel,
} from "../shared/mod.ts";
import { agentMcpSettingsKey, translate } from "../shared/mod.ts";
import type { StellaAgent, StellaAgentRepo } from "../stella/agents.ts";
import {
  DEFAULT_AGENT_NAME,
  normalizeAgentModel,
  normalizeAgentName,
} from "../stella/agents.ts";
import type { AgentIconStore } from "../stella/icons.ts";
import { STELLA_ONBOARDING_PROMPT } from "../stella/onboarding.ts";
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
      agents: StellaAgentRepo;
      icons: AgentIconStore;
      sessions: SessionRepo;
      messages: MessageRepo;
      /** Remove a conversation and everything it published (the same entry
       * point the session API uses, so an agent's files do not outlive it). */
      deleteSession(id: string): Promise<void>;
      language(): Locale;
      /** Publish an event to every frontend listener. */
      emit(event: ClientEvent): void;
      /** Prepare the agent's folder and MEMORY.md in the machine, when it
       * is running. */
      prepareAgentFolder(agentId: string): Promise<void>;
      /** Give back the machine a deleted agent held. */
      removeAgentMachine(agentId: string): Promise<void>;
      /** The settings store, so a deleted agent's own MCP config (which may
       * hold tokens) does not outlive it. */
      settings: { delete(key: string): void };
      /** Stop the machine of an agent that was switched off. */
      stopAgentMachine(agentId: string): Promise<void>;
      modelExists(provider: string, modelId: string): boolean;
      thinkingLevelsOf(provider: string, modelId: string): ThinkingLevel[];
      setModelThinkingLevel(
        provider: string,
        modelId: string,
        level: string,
      ): void;
      sessionOf(agentId: string): SessionInfo | undefined;
      setSessionModel(
        sessionId: string,
        provider: string,
        modelId: string,
      ): void;
      resolveDefaultModel(): Promise<{ provider: string; modelId: string }>;
      closeSession(sessionId: string): Promise<void>;
      agentRuntime(sessionId: string): { isStreaming: boolean } | undefined;
      startOnboarding(sessionId: string, instruction: string): void;
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
        this.deps.sessions.getByPersona(agent.id)?.mainAgentId,
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
  async ensureStellaAgent(): Promise<StellaAgent> {
    const loadIcon = this.starterIcon;
    const existing = this.deps.agents.latest();
    if (existing !== undefined) return existing;
    const starter = this.deps.agents.create({
      name: translate(this.deps.language(), "chat.stella.agents.starterName"),
      role: translate(this.deps.language(), "chat.stella.agents.starterRole"),
    });
    if (loadIcon === undefined) {
      await this.deps.prepareAgentFolder(starter.id);
      return starter;
    }
    try {
      const bytes = await loadIcon();
      if (bytes === undefined) return starter;
      // The store generates the file name; the row keeps it. A failure here
      // must not stop the first conversation from existing, so the agent
      // keeps its initial and the build's missing icon is reported once.
      const name = await this.deps.icons.put(starter.id, bytes, ".png");
      this.deps.agents.update(starter.id, { icon: name });
      const stored = this.deps.agents.get(starter.id) ?? starter;
      await this.deps.prepareAgentFolder(stored.id);
      return stored;
    } catch (error) {
      console.warn("starter agent icon could not be stored:", error);
      await this.deps.prepareAgentFolder(starter.id);
      return starter;
    }
  }

  /** The picture a first-run agent starts with. The server passes its own
   * PWA icon, so the starter agent looks like the app that created it
   * instead of an initial. */
  setStarterAgentIcon(
    source: (() => Promise<Uint8Array | undefined>) | undefined,
  ): void {
    this.starterIcon = source;
  }

  private starterIcon: (() => Promise<Uint8Array | undefined>) | undefined;

  /** The most recently used agent, or undefined when there is none. */
  latestAgent(): StellaAgent | undefined {
    return this.deps.agents.latest();
  }

  /** One agent by id, or undefined when it does not exist. */
  getStellaAgent(id: string): StellaAgent | undefined {
    return this.deps.agents.get(id);
  }

  /** Claim the right to start this agent's setup turn (see
   * StellaAgentRepo.markOnboarded): true for exactly one caller. */
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
  async createStellaAgent(input: {
    name: string;
    role: string;
  }): Promise<StellaAgent> {
    const name = input.name.trim();
    let agent: StellaAgent;
    if (name.length === 0) {
      agent = this.deps.agents.create({
        ...input,
        name: this.unusedAgentName(DEFAULT_AGENT_NAME),
      });
    } else {
      this.requireUnusedAgentName(name);
      agent = this.deps.agents.create(input);
    }
    await this.deps.prepareAgentFolder(agent.id);
    return agent;
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

  /**
   * Start a new agent's setup turn, once.
   *
   * Opening its conversation is the first moment the machine is up, the
   * session exists, and the app can speak before the user does. The turn is
   * a prompt only the model reads: the conversation shows the agent's
   * greeting and questions, never the instruction to ask them.
   *
   * Returns whether this call started it. False also covers "a run is
   * already going": the claim is left empty there, so the next open tries
   * again instead of steering setup text into someone's work.
   */
  startOnboarding(agentId: string): boolean {
    const agent = this.deps.agents.get(agentId);
    if (agent === undefined || agent.disabledAt !== null) return false;
    if (agent.onboardedAt !== null) return false;
    const session = this.deps.sessionOf(agentId);
    if (session === undefined) return false;
    const open = this.deps.agentRuntime(session.id);
    if (open === undefined || open.isStreaming) return false;
    if (!this.markOnboarded(agentId)) return false;
    try {
      this.deps.startOnboarding(session.id, STELLA_ONBOARDING_PROMPT);
    } catch (error) {
      this.clearOnboarded(agentId);
      console.warn("stella setup turn did not start:", error);
      return false;
    }
    return true;
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
   * is not talking to it (see StellaAgentRepo.update).
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
   *
   * `enabled` is `undefined` for "leave it", `false` to switch the agent off
   * and `true` to switch it back on. Again only the ROW is written: closing
   * the conversation, giving its desktop back and stopping its routines need
   * the pool, the machine and the scheduler, which live above this service.
   */
  async updateStellaAgent(
    id: string,
    patch: {
      name?: string;
      icon?: { bytes: Uint8Array; extension: string } | null;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: { provider: string; modelId: string; level: string };
      enabled?: boolean;
    },
  ): Promise<StellaAgent> {
    const agent = this.deps.agents.get(id);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    const name =
      patch.name === undefined ? undefined : normalizeAgentName(patch.name);
    if (name !== undefined) this.requireUnusedAgentName(name, id);
    const model =
      patch.model === undefined ? undefined : normalizeAgentModel(patch.model);
    if (
      model !== undefined &&
      model !== null &&
      !this.deps.modelExists(model.provider, model.modelId)
    ) {
      throw new CoreError(
        `Model not found: ${model.provider}/${model.modelId}`,
        "not_found",
      );
    }
    const thinking = patch.thinkingLevel;
    if (thinking !== undefined) {
      if (!isThinkingLevel(thinking.level)) {
        throw new CoreError(
          `Unknown thinking level: ${thinking.level}`,
          "invalid",
        );
      }
      const offered = this.deps.thinkingLevelsOf(
        thinking.provider,
        thinking.modelId,
      );
      if (!offered.includes(thinking.level)) {
        throw new CoreError(
          `${thinking.provider}/${thinking.modelId} does not support the thinking level "${thinking.level}"`,
          "invalid",
        );
      }
    }
    const fields = {
      ...(name === undefined ? {} : { name }),
      ...(model === undefined ? {} : { model }),
    };

    // Back to the initial: the row stops naming the file, then the file goes.
    // Nothing else in this patch can fail after that. The row is written even
    // when the agent had no picture, because the same patch may carry a name
    // or a model (a no-op write is skipped by StellaAgentRepo.update).
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

    // On/off is a column of its own: it moves neither the name nor the
    // picture, and it must not move `updated_at`, which orders the list by
    // when the conversation last spoke. The first timestamp is kept when the
    // agent is already off, so repeating the request does not restamp it.
    if (patch.enabled !== undefined) {
      const disabledAt = patch.enabled
        ? null
        : (agent.disabledAt ?? Date.now());
      if (disabledAt !== agent.disabledAt) {
        this.deps.agents.setDisabled(id, disabledAt);
      }
    }

    if (patch.enabled === false) await this.release(id);
    if (model !== undefined) await this.applyModel(id, model);
    if (thinking !== undefined) {
      this.deps.setModelThinkingLevel(
        thinking.provider,
        thinking.modelId,
        thinking.level,
      );
    }

    const updated = this.deps.agents.get(id);
    if (updated === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    return updated;
  }

  /** Give back everything a disabled agent was holding. */
  private async release(agentId: string): Promise<void> {
    const session = this.deps.sessionOf(agentId);
    try {
      if (session !== undefined) await this.deps.closeSession(session.id);
    } finally {
      await this.deps.stopAgentMachine(agentId);
    }
  }

  /** Point an agent's conversation at `model` (null = the app's default). */
  private async applyModel(
    agentId: string,
    model: { provider: string; modelId: string } | null,
  ): Promise<void> {
    const session = this.deps.sessionOf(agentId);
    if (session === undefined) return;
    let wanted = model;
    if (wanted === null) {
      try {
        wanted = await this.deps.resolveDefaultModel();
      } catch {
        return;
      }
    }
    if (
      session.modelProvider === wanted.provider &&
      session.modelId === wanted.modelId
    ) {
      return;
    }
    this.deps.setSessionModel(session.id, wanted.provider, wanted.modelId);
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
    const session = this.deps.sessions.getByPersona(id);
    if (session !== undefined) await this.deps.deleteSession(session.id);
    this.deps.agents.delete(id);
    // The picture belongs to the agent: once the row is gone nothing can
    // name it, and the store's directory would outlive every reference.
    await this.deps.icons.deleteAgent(id);
    // Its MCP config is per agent and may hold tokens; nothing can name it
    // once the row is gone.
    this.deps.settings.delete(agentMcpSettingsKey(id));
    await this.deps.removeAgentMachine(id);
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
