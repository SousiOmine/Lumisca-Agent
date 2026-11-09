import type { SessionInfo } from "../domain/session.ts";
import type { ClientEvent } from "../domain/event.ts";
import type { AgentRepo } from "../stella/agents.ts";
import type { SessionRepo } from "../session/repo.ts";
import type { MessageRepo } from "../session/messages.ts";
import type { SessionPool } from "../agent/pool.ts";
import type { RoutineRepo } from "../routine/repo.ts";
import type { RoutineScheduler } from "../routine/scheduler.ts";
import type { StellaMachine } from "../vm/machine.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
import type { VmManager, VmProgress } from "../vm/container.ts";
import type { StellaAvailability } from "../vm/availability.ts";
import type { StellaStatus } from "../shared/wire.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { Workspace } from "../domain/workspace.ts";
import type { Locale } from "../shared/mod.ts";
import { CoreError, errorMessage } from "../errors.ts";
import type { HandoverRegistry } from "../vm/handover-registry.ts";
import { StellaSkillCache } from "../stella/skill-cache.ts";
import { vmAgentDir } from "../vm/contract.ts";
import { VmFileBackend } from "../vm/fs.ts";
import {
  VmBackgroundSpawner,
  VmCommandRunner as VmCommandRunnerImpl,
} from "../vm/shell.ts";
import { createVmScreen } from "../vm/screen.ts";
import { createVmTools } from "../vm/tools.ts";
import { createVmLaunchTool } from "../vm/launcher.ts";
import { createVmAskUserTool } from "../vm/ask-user.ts";
import { createVmSemanticTools } from "../vm/semantic.ts";
import { createRoutineTools } from "../routine/tools.ts";
import { createAgentCreateTool } from "../stella/tools.ts";
import { createHistorySearchTool } from "../session/history.ts";
import {
  createIdentityProvider,
  createIdentityTool,
} from "../stella/identity.ts";
import { stellaEntryOf } from "../agent/stella-stream.ts";
import type { StellaEntry } from "../domain/stella-conversation.ts";
import type { AgentMessage } from "../ai/types.ts";
import type { IdentityTarget } from "../stella/identity.ts";

/** The conversation entries a set of stored rows projects to, oldest first —
 * the same projection the conversation endpoints serve. */
function entriesOf(messages: readonly AgentMessage[]): StellaEntry[] {
  const entries: StellaEntry[] = [];
  for (const message of messages) {
    const entry = stellaEntryOf(message);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * The stella machine and the conversations that run inside it.
 *
 * The machine (a podman container) is attached by the server at startup; this
 * class owns what depends on it — the availability verdict, the skill catalog
 * the agent factory cannot await, the hand-over hubs a screen prompt blocks
 * on, and the runtime each conversation's tools run through.
 *
 * Extracted from LumiscaCore together with the conversation-opening path: they
 * are one question ("where does a stella conversation work") and were 490
 * lines of the facade. The agent REGISTRY stayed in `StellaAgentService`; this is
 * the machine side.
 */
export class StellaMachineService {
  /** The catalog of each agent, as last read (see StellaSkillCache). */
  private readonly skills = new StellaSkillCache();

  constructor(
    private readonly deps: {
      machine: StellaMachine;
      agents: AgentRepo;
      sessions: SessionRepo;
      messages: MessageRepo;
      pool: SessionPool;
      routineRepo: RoutineRepo;
      routineScheduler: RoutineScheduler;
      /** Per-session hand-over hubs; the core's close path forgets them. */
      handovers: HandoverRegistry;
      decorateSession(session: SessionInfo): SessionInfo;
      deleteSession(id: string): Promise<void>;
      emit(event: ClientEvent): void;
      language(): Locale;
      chatWorkspace(): Workspace;
      requireWorkspace(id: string): Workspace;
      resolveDefaultModel(
        provider?: string,
        modelId?: string,
      ): Promise<{ provider: string; modelId: string }>;
      createStellaAgent(
        input: { name: string; role: string },
      ): Promise<import("../stella/agents.ts").StellaAgent>;
    },
  ) {}

  // --- the stella machine --------------------------------------------------

  /** Attach the stella machine (the server does this at start-up, once it
   * has resolved where the container files live). Detach with undefined. */
  setStellaVm(vm: VmManager | undefined): void {
    this.deps.machine.set(vm);
  }

  /** The machine, when one is attached. */
  getStellaVm(): VmManager | undefined {
    return this.deps.machine.get();
  }

  /** Whether stella mode can run here, with the reason when it cannot. Read
   * from the machine's actual state, so installing podman or building the
   * image takes effect without a restart. */
  async getStellaAvailability(): Promise<StellaAvailability> {
    return await this.deps.machine.availability();
  }

  // --- stella agents (the agent of each conversation) -----------------------

  /** The agents in the sidebar, most recently used first. */
  // --- stella agents (delegated to StellaAgentService) -------------------------

  /** The agents in the sidebar, most recently used first. */
  async getOrCreateStellaSession(agentId?: string): Promise<SessionInfo> {
    const agent = agentId !== undefined
      ? this.deps.agents.get(agentId)
      : this.deps.agents.latest();
    if (agent === undefined) {
      throw new CoreError(
        agentId !== undefined
          ? `Agent not found: ${agentId}`
          : "No agent yet: create one before talking to stella",
        "not_found",
      );
    }
    // An already-open conversation usually needs none of the preparation
    // below. Its agent is in the pool, and the skill catalog and working
    // folder are what opening it created. The one thing that can have changed
    // is the machine itself (stopped by hand, or the app that owns it looked
    // at nothing for a while), so that is asked — cheaply, from the status
    // read the client is already polling (see isRunning) — and everything
    // else is skipped when it answers.
    const existing = this.deps.sessions.getByAgent(agent.id);
    // The conversation is named after its agent: that is the name the user
    // gave it, and the one both the header and the notifications show. A
    // conversation opened before stella stopped generating titles carries a
    // title made from its first message, so the row is aligned here (and
    // again when the agent is renamed). Two names for one conversation is
    // what made notifications look stuck on the first message.
    if (existing !== undefined && existing.name !== agent.name) {
      this.deps.sessions.rename(existing.id, agent.name);
    }
    if (
      existing !== undefined && this.deps.pool.get(existing.id) !== undefined
    ) {
      if (await this.deps.machine.isRunning()) {
        this.deps.agents.touch(agent.id);
        return this.deps.decorateSession(
          this.deps.sessions.get(existing.id) ?? existing,
        );
      }
    }
    // The machine must be running before an agent is built on it: without one
    // the factory refuses (never a stella agent with host tools). Every
    // caller that wants a conversation wants the machine, so this starts it
    // rather than making the client ask.
    await this.ensureStellaReady();
    // The two steps that follow run together because neither depends on the
    // other and both cross into the container (`podman exec`): the skill
    // catalog the factory cannot await (it builds the tools synchronously)
    // and the agent's working folder, which bash cannot start in when it does
    // not exist (`podman exec --workdir`). In sequence they were two round
    // trips the user waited for.
    await Promise.all([
      this.primeStellaSkills(agent.id),
      this.deps.machine.ensureAgentFolder(agent.id),
    ]);
    this.deps.agents.touch(agent.id);
    if (existing !== undefined) {
      const rows = this.deps.messages.listModelView(existing.id);
      const view = {
        messages: rows.map((row) => row.message),
        baseIndex: this.deps.messages.count(existing.id, "all") - rows.length,
      };
      this.deps.pool.open(
        existing,
        this.deps.requireWorkspace(existing.workspaceId),
        view.messages,
        view.baseIndex,
      );
      return this.deps.decorateSession(
        this.deps.sessions.get(existing.id) ?? existing,
      );
    }
    // The agent's own model, or the app's default when it has none: the
    // choice lives on the agent so it can be made before the conversation
    // exists.
    const model = agent.model ??
      await this.deps.resolveDefaultModel(undefined, undefined);
    const workspace = this.deps.chatWorkspace();
    const session = this.deps.sessions.create({
      workspaceId: workspace.id,
      name: agent.name,
      modelProvider: model.provider,
      modelId: model.modelId,
      stella: true,
      agentId: agent.id,
    });
    this.deps.pool.open(session, workspace, []);
    const decorated = this.deps.decorateSession(
      this.deps.sessions.get(session.id) ?? session,
    );
    this.deps.emit({ type: "session_created", session: decorated });
    return decorated;
  }

  /**
   * Make sure the machine is up, starting it (and building its image on a
   * first run) when it is not.
   *
   * There is no "start the machine" step in the product any more: a user who
   * chose stella mode asked for a machine, not for a container to babysit, so
   * every path that needs one calls this and the machine appears. The one
   * thing that cannot be automated is the wait: a first run builds a Debian
   * image with Chromium in it, which takes minutes, and the caller reports
   * that through the progress callback rather than freezing.
   *
   * Idempotent and safe to call concurrently: two prompts racing on a cold
   * machine share one start (the promise is memoized until it settles).
   */
  async ensureStellaReady(
    onProgress?: (progress: VmProgress) => void,
  ): Promise<void> {
    try {
      await this.deps.machine.ensureReady(onProgress);
    } catch (error) {
      // The machine's reasons are user-facing (an image to build, podman
      // missing); classify them as unavailable, not as a server fault.
      throw new CoreError(errorMessage(error), "unavailable");
    }
  }

  /** Whether a machine start is in flight (the status endpoint reports it so
   * a waiting client can say "starting" instead of showing a stale state). */
  isStellaStarting(): boolean {
    return this.deps.machine.starting;
  }

  /**
   * The machine's state.
   *
   * stella's UI shows no machine controls, so this is not a dashboard: it
   * exists for the client to know (a) whether the mode is offerable at all
   * and (b) whether the screen pane can connect. `starting` carries the
   * first-run build, which is the one wait the user does see.
   */
  async getStellaStatus(): Promise<StellaStatus> {
    return await this.deps.machine.status();
  }

  /**
   * Create one agent's working folder and its MEMORY.md now, when the machine
   * is up.
   *
   * Called as the agent is created, so the file the system prompt promises is
   * there before the agent's first turn. Creating an agent does not START the
   * machine: a container that is not running is brought up by the first
   * conversation (see getOrCreateStellaSession), and that path prepares the
   * folder too, so a stopped machine only moves the work to that moment.
   */
  async prepareAgentFolder(agentId: string): Promise<void> {
    if (!(await this.deps.machine.isRunning())) return;
    await this.deps.machine.ensureAgentFolder(agentId);
  }

  /** The hand-over hub of one session (see vm/handover.ts): created on
   * first use and dropped on close, so a torn-down session leaves nothing
   * waiting. */
  /** The hand-over hub of a session (created on first use). */
  private handoverFor(sessionId: string) {
    return this.deps.handovers.for(sessionId);
  }

  /** The runtime a stella session's tools run on, or undefined for every
   * other session (the factory asks per open). */
  stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined {
    if (session.stella !== true) return undefined;
    const exec = this.deps.machine.exec();
    const execBytes = this.deps.machine.execBytes();
    if (exec === undefined || execBytes === undefined) return undefined;
    // The identity belongs to the AGENT row, not to the session, and a stella
    // session always has one (the conversation is created FOR an agent). A
    // session without one would have nowhere to keep the text, so it fails
    // here rather than opening with an identity that is silently lost.
    const agentId = session.agentId;
    if (agentId === undefined) {
      throw new CoreError(
        "The stella session has no agent: its identity has nowhere to live",
        "invalid",
      );
    }
    // The agent's own skill catalog: its folder holds the skills it wrote,
    // and the machine-wide folder is merged in (see vm/skills.ts). Read
    // through a getter for the same reason the factory asks for one — the
    // catalog is re-read when the conversation is opened.
    const skills = (): SkillDef[] => this.deps.machine.skills(agentId);
    // The agent's working folder: relative paths and bash start here, the
    // way a workspace folder does in code mode. It is a default place, not a
    // boundary — the file backend's root is the machine's home, so one agent
    // can reach another's folder when the user asks (see vm/fs.ts).
    const cwd = vmAgentDir(agentId);
    // One backend for the whole runtime: the file tools and `agent_create`
    // resolve paths the same way, so a role file is exactly a file this
    // agent may read.
    const files = new VmFileBackend(exec, { cwd });
    const identity: IdentityTarget = {
      read: () => this.deps.agents.get(agentId)?.identity ?? "",
      write: (content) => this.deps.agents.writeIdentity(agentId, content),
    };
    return {
      cwd,
      files,
      runner: new VmCommandRunnerImpl(exec),
      backgroundSpawner: new VmBackgroundSpawner(exec),
      skills,
      refreshSkills: () => this.deps.machine.refreshSkills(agentId),
      screenTools: [
        ...createVmTools({ screen: createVmScreen({ exec, execBytes }) }),
        createVmLaunchTool({ exec }),
        createVmAskUserTool({
          handover: this.handoverFor(session.id),
        }),
      ],
      semanticTools: createVmSemanticTools({ exec }),
      handoverHub: this.handoverFor(session.id),
      routineTools: createRoutineTools({
        repo: this.deps.routineRepo,
        scheduler: this.deps.routineScheduler,
        agentId: session.agentId ?? "",
      }),
      // The tool goes through the same entry point as the API, so the
      // duplicate-name rule is enforced once. It reads a `role_file` through
      // the session's own backend, so a role file is a file the agent could
      // have read itself.
      agentTool: createAgentCreateTool({
        files,
        create: (input) => this.deps.createStellaAgent(input),
      }),
      // The history of THIS conversation: each stella agent has its own
      // transcript, so the tool is built per open around the session's rows.
      // It searches the conversation's ENTRIES, not the transcript: what the
      // user sees is what the agent can search (see session/history.ts), and
      // the projection is the same one the conversation endpoints serve.
      historyTool: createHistorySearchTool({
        entries: (window) =>
          entriesOf(
            this.deps.messages.listBetween(session.id, window).map((row) =>
              row.message
            ),
          ),
      }),
      // The identity belongs to this agent: the tool writes it, and the
      // provider publishes what was written as a context message, so the
      // snapshotted system prompt never has to change.
      identityTool: createIdentityTool(identity),
      identityProvider: createIdentityProvider(identity),
    };
  }

  /** Re-read one stella agent's skill catalog. Awaited before its session
   * opens, so the agent's skill tool starts with a current list. */
  refreshStellaSkills(agentId: string): Promise<void> {
    return this.skills.refresh(
      agentId,
      this.deps.machine.get(),
      () => this.deps.machine.refreshSkills(agentId),
    );
  }

  /**
   * Make one agent's skill catalog current enough to open its conversation.
   *
   * The catalog lives inside the machine, so reading it costs a `podman
   * exec` (and, on a self-hosted server reached over a phone, whatever the
   * link costs on top). A catalog read moments ago — or one this call
   * started — is reused: a skill the agent wrote during a conversation is
   * picked up by the next open after the window, not by the open that is
   * already five calls deep into a cold start.
   *
   * Concurrent opens of the same agent share one read, so two clients cannot
   * queue two `podman exec`s for the same list. Another agent has another
   * folder, hence another entry.
   */
  private primeStellaSkills(agentId: string): Promise<void> {
    return this.skills.prime(
      agentId,
      this.deps.machine.get(),
      () => this.deps.machine.refreshSkills(agentId),
    );
  }
}
