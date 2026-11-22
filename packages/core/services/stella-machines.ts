import type { SessionPool } from "../agent/pool.ts";
import { conversationEntriesOf } from "../agent/stella-stream.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { CoreError, errorMessage } from "../errors.ts";
import type { RoutineRepo } from "../routine/repo.ts";
import type { RoutineScheduler } from "../routine/scheduler.ts";
import { createRoutineTools } from "../routine/tools.ts";
import type { MessageRepo } from "../session/messages.ts";
import { modelViewOf } from "../session/model-view.ts";
import type { SessionRepo } from "../session/repo.ts";
import type { Locale } from "../shared/mod.ts";
import type { StellaMachineStatus, StellaStatus } from "../shared/wire.ts";
import type { SkillDef } from "../skills/discover.ts";
import type { StellaAgentRepo } from "../stella/agents.ts";
import type { IdentityTarget } from "../stella/identity.ts";
import { createIdentityTool } from "../stella/identity.ts";
import { StellaSkillCache } from "../stella/skill-cache.ts";
import { createAgentCreateTool } from "../stella/tools.ts";
import { createHistorySearchTool } from "../tools/history.ts";
import { createVmAskUserTool } from "../vm/ask-user.ts";
import type { StellaAvailability } from "../vm/availability.ts";
import type { VmClipboard } from "../vm/clipboard.ts";
import { createVmClipboard } from "../vm/clipboard.ts";
import type { VmExec, VmHost } from "../vm/container.ts";
import { vmAgentDir } from "../vm/contract.ts";
import type { EnvRequestRegistry } from "../vm/env-request.ts";
import { requireEnvValue, VmEnvStore } from "../vm/env-store.ts";
import { createVmEnvTool } from "../vm/env-tool.ts";
import { VmFileBackend } from "../vm/fs.ts";
import type { HandoverRegistry } from "../vm/handover-registry.ts";
import { createVmLaunchTool } from "../vm/launcher.ts";
import type { StellaMachine } from "../vm/machine.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
import { createVmScreen } from "../vm/screen.ts";
import { createVmSemanticTools } from "../vm/semantic.ts";
import {
  VmBackgroundSpawner,
  VmCommandRunner as VmCommandRunnerImpl,
} from "../vm/shell.ts";
import { createVmTools } from "../vm/tools.ts";
import type { NewSession } from "./session-lifecycle.ts";

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
  /** The machines' variable store, kept across sessions so its write queue
   * serializes two dialogs answered at once (see VmEnvStore). One store for
   * every agent: they share the home volume, so `env.json` is one file and
   * two queues would lose an update. Rebuilt when a different host is
   * attached. */
  private envStoreOf: { host: VmHost; store: VmEnvStore } | undefined;

  constructor(
    private readonly deps: {
      machine: StellaMachine;
      agents: StellaAgentRepo;
      sessions: SessionRepo;
      messages: MessageRepo;
      pool: SessionPool;
      routineRepo: RoutineRepo;
      routineScheduler: RoutineScheduler;
      /** Whether a routine's MCP watch may call a tool, or why not (see
       * mcp/service-checks.ts). Asked before a routine is saved, because a
       * tool that writes would then act on a timer with nobody watching. */
      watchableTool(server: string, tool: string): Promise<string | null>;
      /** Per-session hand-over hubs; the core's close path forgets them. */
      handovers: HandoverRegistry;
      /** Per-session `vm_env` request hubs; forgotten the same way. */
      envRequests: EnvRequestRegistry;
      decorateSession(session: SessionInfo): SessionInfo;
      /** Create a session row, open its agent and announce it — the same
       * path a user's session takes (see SessionLifecycle.createAndAnnounce),
       * so `session_created` has one issuer. */
      createAndAnnounce(input: NewSession): SessionInfo;
      deleteSession(id: string): Promise<void>;
      language(): Locale;
      chatWorkspace(): Workspace;
      requireWorkspace(id: string): Workspace;
      resolveDefaultModel(
        provider?: string,
        modelId?: string,
      ): Promise<{ provider: string; modelId: string }>;
      createStellaAgent(input: {
        name: string;
        role: string;
      }): Promise<import("../stella/agents.ts").StellaAgent>;
    },
  ) {
    // The machine cannot see the conversations, and must not stop a machine
    // somebody is working in: a prompt, a routine, a hand-over the user is
    // answering, or a background command that keeps running after its tool
    // call returned all keep their machine awake. It asks this before it
    // stops one for being idle.
    this.deps.machine.setBusyCheck((agentId) => {
      const session = this.deps.sessions.getByPersona(agentId);
      if (session === undefined) return false;
      if (this.deps.pool.get(session.id)?.isStreaming === true) return true;
      return this.deps.pool
        .getBackground(session.id)
        .some((command) => command.state === "running");
    });
  }

  // --- the stella machine --------------------------------------------------

  /** Attach the machines' host (the server does this at start-up, once it
   * has resolved where the container files live). Detach with undefined. */
  setStellaVm(host: VmHost | undefined): void {
    this.deps.machine.set(host);
    this.envStoreOf = undefined;
    if (host !== undefined) {
      // A previous process may have left machines running. Adopt them in the
      // background so the warm floor counts them and the reaper can settle
      // them; opening a conversation must not wait for the scan.
      const agentIds = this.deps.agents
        .list()
        .filter((agent) => agent.disabledAt === null)
        .map((agent) => agent.id);
      void this.deps.machine.reconcile(agentIds).catch(() => {
        // Housekeeping: a failed read leaves the machine unknown, and the
        // next open asks again.
      });
    }
  }

  /** The host, when one is attached. */
  getStellaVm(): VmHost | undefined {
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
    const agent =
      agentId !== undefined
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
    // A disabled agent has nothing to open: building it would undo the
    // release that disabling performed (see LumiscaCore.releaseStellaAgent),
    // and its conversation is served from the store instead (see
    // readStellaConversationFromStore). This guard is what keeps a routine or
    // a second client from rebuilding it behind the user's back.
    if (agent.disabledAt !== null) {
      throw new CoreError(`Agent ${agent.id} is disabled`, "conflict");
    }
    // An already-open conversation needs none of the preparation below: its
    // agent is in the pool, and the skill catalog and working folder are
    // what opening it created. Opening never asks whether the machine is up
    // — a machine that went to sleep is woken by the first prompt or tool
    // call, not by the act of looking at the conversation — so this returns
    // without a `podman` call.
    const existing = this.deps.sessions.getByPersona(agent.id);
    if (
      existing !== undefined &&
      this.deps.pool.get(existing.id) !== undefined
    ) {
      this.deps.agents.touch(agent.id);
      return this.deps.decorateSession(
        this.deps.sessions.get(existing.id) ?? existing,
      );
    }
    // Opening a conversation prepares the IMAGE, never a container. The
    // machines sleep when nobody uses them, and a user browsing the sidebar
    // would otherwise pay a browser for every row they looked at. The first
    // prompt or tool call wakes the machine (see StellaMachine.exec).
    await this.ensureStellaImage();
    // The two steps below cross into the container (`podman exec`), so they
    // run only when its machine is already up: the skill catalog the factory
    // cannot await (it builds the tools synchronously) and the agent's
    // working folder, which bash cannot start in when it does not exist. A
    // sleeping machine has neither yet, and the first prompt reads the
    // catalog after it wakes (see ensureStellaSkills).
    if (await this.deps.machine.isRunning(agent.id)) {
      await Promise.all([
        this.primeStellaSkills(agent.id),
        this.deps.machine.ensureAgentFolder(agent.id),
      ]);
    }
    this.deps.agents.touch(agent.id);
    if (existing !== undefined) {
      const view = modelViewOf(this.deps.messages, existing.mainAgentId);
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
    const model =
      agent.model ??
      (await this.deps.resolveDefaultModel(undefined, undefined));
    return this.deps.createAndAnnounce({
      workspace: this.deps.chatWorkspace(),
      // No name of its own: a stella conversation is the agent talking, and
      // the agent's name is read on every read (see SessionRepo.toSession).
      // The column is NOT NULL, so it holds the empty string — the marker
      // of a session that has no name but its agent's.
      name: "",
      modelProvider: model.provider,
      modelId: model.modelId,
      personaId: agent.id,
    });
  }

  /**
   * Make sure one agent's machine is up, starting it (and building its image
   * on a first run) when it is not.
   *
   * There is no "start the machine" step in the product: a user who chose
   * stella mode asked for a machine, not for a container to babysit, so every
   * path that needs one calls this and it appears. The one thing that cannot
   * be automated is the wait: a first run builds a Debian image with Chromium
   * in it, which takes minutes, and the caller reports that through the
   * progress callback rather than freezing.
   *
   * Idempotent and safe to call concurrently: two prompts racing on a
   * sleeping machine share one start.
   */
  async ensureStellaReady(agentId: string): Promise<void> {
    // The machine classifies its own failures (podman missing, image build
    // failed) as unavailable; re-wrapping them here turned a classified
    // failure into a 500 and dropped the original kind.
    await this.deps.machine.ensureReady(agentId);
  }

  /** Build the image when it is missing or stale, without starting a
   * container. Opening a conversation does this so its first prompt does not
   * wait minutes for a build. */
  async ensureStellaImage(): Promise<void> {
    await this.deps.machine.ensureImage();
  }

  /** Whether the installation's image is being built (the status endpoint
   * reports it so a waiting client can say "preparing" instead of showing a
   * stale state). */
  isStellaStarting(): boolean {
    return this.deps.machine.building;
  }

  /**
   * What the installation can do for stella mode.
   *
   * stella's UI shows no machine controls, so this is not a dashboard: it
   * exists for the client to know (a) whether the mode is offerable at all
   * and (b) whether the image is being prepared. Each agent's machine has its
   * own state (`stellaAgentStatus`), because the machines sleep and wake
   * independently.
   */
  async getStellaStatus(): Promise<StellaStatus> {
    return await this.deps.machine.status();
  }

  /** One agent's machine, as the screen pane draws it. */
  async stellaAgentStatus(agentId: string): Promise<StellaMachineStatus> {
    const agent = this.deps.agents.get(agentId);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${agentId}`, "not_found");
    }
    if (agent.disabledAt !== null) {
      // A disabled agent has no machine to show and asking would start it.
      return { state: "stopped", starting: false, reason: "" };
    }
    const status = await this.deps.machine.machineStatus(agentId);
    if (status === undefined) {
      return {
        state: "podman_missing",
        starting: false,
        reason: "the virtual machine is not set up for this installation",
      };
    }
    return {
      state: status.state,
      starting: this.deps.machine.isStarting(agentId),
      reason: status.reason,
    };
  }

  /** Wake one agent's machine without waiting for a prompt (the pane's wake
   * button). */
  async wakeStellaAgent(agentId: string): Promise<void> {
    const agent = this.deps.agents.get(agentId);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${agentId}`, "not_found");
    }
    if (agent.disabledAt !== null) {
      throw new CoreError(`Agent ${agentId} is disabled`, "conflict");
    }
    await this.ensureStellaReady(agentId);
  }

  /** Note that the user is driving one agent's screen, which keeps its
   * machine awake (see VM_IDLE_SLEEP_MS). */
  touchStellaAgent(agentId: string): void {
    this.deps.machine.touch(agentId);
  }

  /** A screen pane opened on one agent: keep its machine warm while the pane
   * is open, even when no tool has run in it. */
  watchStellaAgent(agentId: string): void {
    this.deps.machine.watch(agentId);
  }

  /** The screen pane closed: the idle clock starts from now. */
  unwatchStellaAgent(agentId: string): void {
    this.deps.machine.unwatch(agentId);
  }

  /** The host port of one agent's screen, or null when there is no such
   * agent or no machine. Opening the screen pane before the agent has used
   * it starts the desktop, so the reader sees the same empty desktop the
   * agent is about to work in. */
  async stellaVncPort(agentId: string): Promise<number | null> {
    const agent = this.deps.agents.get(agentId);
    // A disabled agent has no screen to show, and asking the machine for one
    // would start the desktop this state exists to release.
    if (agent === undefined || agent.disabledAt !== null) return null;
    return await this.deps.machine.vncPortFor(agentId);
  }

  /** Stop one agent's machine (see StellaMachine.release). Called when the
   * agent is disabled: nothing may keep working in a machine nobody can
   * open. */
  async stopAgentMachine(agentId: string): Promise<void> {
    await this.deps.machine.release(agentId);
  }

  /** Remove one agent's container after the agent is deleted. Its files stay
   * on the shared home volume. */
  async removeAgentMachine(agentId: string): Promise<void> {
    await this.deps.machine.remove(agentId);
  }

  /**
   * Create one agent's working folder and its MEMORY.md now, when the machine
   * is up.
   *
   * Called as the agent is created, so the file the system prompt promises is
   * there before the agent's first turn. Creating an agent does not START the
   * machine: a machine that is not running is woken by the first prompt or
   * tool call, and opening the conversation prepares the folder when it is
   * already up, so a sleeping machine only moves the work to that moment.
   */
  async prepareAgentFolder(agentId: string): Promise<void> {
    if (!(await this.deps.machine.isRunning(agentId))) return;
    await this.deps.machine.ensureAgentFolder(agentId);
  }

  /** The hand-over hub of one session (see vm/handover.ts): created on
   * first use and dropped on close, so a torn-down session leaves nothing
   * waiting. */
  /** The hand-over hub of a session (created on first use). */
  private handoverFor(sessionId: string) {
    return this.deps.handovers.for(sessionId);
  }

  /** The clipboard of one conversation's screen (see vm/clipboard.ts).
   *
   * Built per call rather than kept on the runtime: it holds nothing between
   * calls, and the chat's screen pane asks for it only while the user is at
   * the screen. It goes through the AGENT's seam, not the machine's: an X
   * selection belongs to a display, and the machine's own (`:99`) is on no
   * conversation's screen. A conversation whose machine was replaced between
   * opens must not be answered from an old seam (the seam is rebuilt with the
   * machine, see StellaMachine).
   */
  private clipboardOf(session: SessionInfo): VmClipboard {
    if (session.stella !== true) {
      throw new CoreError(
        "Only a stella conversation has a machine clipboard",
        "not_found",
      );
    }
    const agentId = session.personaId;
    if (agentId === undefined) {
      throw new CoreError(
        "The stella session has no agent: its screen has no clipboard",
        "invalid",
      );
    }
    const exec = this.deps.machine.screenExec(agentId);
    if (exec === undefined) {
      throw new CoreError(
        "stella mode is not available: the virtual machine is not set up for this installation",
        "unavailable",
      );
    }
    return createVmClipboard({ exec });
  }

  /** The text on the machine's clipboard (empty when nothing was copied). */
  async readClipboard(session: SessionInfo): Promise<string> {
    return await this.clipboardOf(session).read();
  }

  /** Put `text` on the machine's clipboard, for the application the user is
   * about to paste into. */
  async writeClipboard(session: SessionInfo, text: string): Promise<void> {
    await this.clipboardOf(session).write(text);
  }

  /** The runtime a stella session's tools run on, or undefined for every
   * other session (the factory asks per open). */
  stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined {
    if (session.stella !== true) return undefined;
    // The identity belongs to the AGENT row, not to the session, and a stella
    // session always has one (the conversation is created FOR an agent). A
    // session without one would have nowhere to keep the text, so it fails
    // here rather than opening with an identity that is silently lost.
    const agentId = session.personaId;
    if (agentId === undefined) {
      throw new CoreError(
        "The stella session has no agent: its identity has nowhere to live",
        "invalid",
      );
    }
    const exec = this.deps.machine.exec(agentId);
    const execBytes = this.deps.machine.execBytes(agentId);
    if (exec === undefined || execBytes === undefined) return undefined;
    // The agent's own machine and desktop. Only the tools that work on the
    // screen get the screen seam: it starts the desktop on first use, so a
    // conversation that never looks at a screen never pays for a browser.
    // Files, the shell and a background command use the machine's seam —
    // they are not screen work, and starting a browser under `ls` would be
    // one for nothing. A program is started with `vm_launch`, which is on
    // the screen seam.
    const screenExec = this.deps.machine.screenExec(agentId);
    const screenExecBytes = this.deps.machine.screenExecBytes(agentId);
    if (screenExec === undefined || screenExecBytes === undefined) {
      throw new CoreError(
        "The machine went away while the conversation was opening",
        "unavailable",
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
    // The scripting tool call's channel: the program runs under the machine's
    // own node and asks the server for each tool call (see
    // code-execution/vm.ts).
    const channel = this.deps.machine.channel(agentId);
    if (channel === undefined) {
      throw new CoreError(
        "The machine went away while the conversation was opening",
        "unavailable",
      );
    }
    const identity: IdentityTarget = {
      read: () => this.deps.agents.get(agentId)?.identity ?? "",
      write: (content) => this.deps.agents.writeIdentity(agentId, content),
    };
    return {
      cwd,
      files,
      runner: new VmCommandRunnerImpl(exec),
      exec,
      channel,
      backgroundSpawner: new VmBackgroundSpawner(exec),
      skills,
      refreshSkills: () => this.deps.machine.refreshSkills(agentId),
      screenTools: [
        ...createVmTools({
          screen: createVmScreen({
            exec: screenExec,
            execBytes: screenExecBytes,
          }),
        }),
        createVmLaunchTool({ exec: screenExec }),
        createVmAskUserTool({
          handover: this.handoverFor(session.id),
        }),
      ],
      semanticTools: createVmSemanticTools({ exec: screenExec }),
      handoverHub: this.handoverFor(session.id),
      envTool: createVmEnvTool({
        requests: this.deps.envRequests.for(session.id),
        store: this.envStore(exec),
      }),
      envRequestHub: this.deps.envRequests.for(session.id),
      routineTools: createRoutineTools({
        repo: this.deps.routineRepo,
        scheduler: this.deps.routineScheduler,
        agentId: session.personaId ?? "",
        watchable: (server, tool) => this.deps.watchableTool(server, tool),
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
      // user sees is what the agent can search (see tools/history.ts), and
      // the projection is the same one the conversation endpoints serve.
      historyTool: createHistorySearchTool({
        entries: (window) =>
          conversationEntriesOf(
            this.deps.messages
              .listBetween(session.mainAgentId, window)
              .map((row) => row.message),
          ),
      }),
      // The identity belongs to this agent: the tool reads and writes it,
      // and the system prompt carries the written text from the next
      // generation (see session-prompt.ts's ensureSystemPrompt).
      identityTool: createIdentityTool(identity),
    };
  }

  /** The variable store of the attached machines.
   *
   * One store, not one per agent: every machine mounts the same home, so
   * `env.json` is a single file and two write queues would lose an update
   * that arrives at the same moment. The seam is whichever agent's was
   * available first; writing through it wakes that machine, which is the
   * same work the dialogs' own machines would do. */
  private envStore(exec: VmExec): VmEnvStore {
    const host = this.deps.machine.get();
    if (host === undefined) {
      throw new CoreError(
        "stella mode is not available: the virtual machine is not set up for this installation",
        "unavailable",
      );
    }
    if (this.envStoreOf?.host === host) return this.envStoreOf.store;
    const store = new VmEnvStore(exec);
    this.envStoreOf = { host, store };
    return store;
  }

  /**
   * Store the value the user typed for the variable `vm_env` asked about,
   * then let the blocked run continue.
   *
   * The name comes from the pending request, never from the request body:
   * an answer can only fill the question that was asked. The value is
   * written before the wait is released — a write that failed must leave the
   * dialog up with its error, not tell the agent that a variable exists.
   *
   * A run that was torn down while the value was being written is not an
   * error here: the value is stored, and there is simply nothing left to
   * resume.
   */
  async provideEnv(
    sessionId: string,
    rawValue: unknown,
    toolCallId?: string,
  ): Promise<void> {
    const hub = this.deps.envRequests.get(sessionId);
    const pending = hub?.pendingEnvRequest() ?? null;
    if (hub === undefined || pending === null) {
      throw new CoreError(
        "No environment variable is waiting for the user",
        "not_found",
      );
    }
    if (toolCallId !== undefined && toolCallId !== pending.toolCallId) {
      throw new CoreError(
        `No environment variable is waiting for tool call: ${toolCallId}`,
        "not_found",
      );
    }
    const value = requireEnvValue(rawValue);
    const session = this.deps.sessions.get(sessionId);
    const agentId = session?.personaId;
    if (agentId === undefined) {
      throw new CoreError(
        "The stella session has no agent: its variables have nowhere to live",
        "invalid",
      );
    }
    const exec = this.deps.machine.exec(agentId);
    if (exec === undefined) {
      throw new CoreError("The stella machine is not running", "unavailable");
    }
    await this.envStore(exec).set(pending.name, value);
    try {
      hub.finish(pending.toolCallId);
    } catch (error) {
      // The run ended while the value was being written (the dialog was
      // closed by `cancelAll`). The value is saved; there is nothing else to
      // do, and reporting a failure would say the save did not happen.
      if (!(error instanceof CoreError) || error.kind !== "not_found") {
        throw error;
      }
    }
  }

  /** The user refused to enter a value: the run continues without it. */
  declineEnv(sessionId: string, toolCallId?: string): void {
    const hub = this.deps.envRequests.get(sessionId);
    if (hub === undefined) {
      throw new CoreError(
        "No environment variable is waiting for the user",
        "not_found",
      );
    }
    hub.decline(toolCallId);
  }

  /** Re-read one stella agent's skill catalog. Awaited before its session
   * opens, so the agent's skill tool starts with a current list. */
  refreshStellaSkills(agentId: string): Promise<void> {
    return this.skills.refresh(agentId, this.deps.machine.get(), () =>
      this.deps.machine.refreshSkills(agentId),
    );
  }

  /** Read one stella agent's skill catalog when this server has not read it
   * yet. A run that starts without opening the conversation (a routine)
   * asks this before its agent is built; opening a conversation instead
   * primes the catalog with `primeStellaSkills`. */
  ensureStellaSkills(agentId: string): Promise<void> {
    return this.deps.machine.ensureSkills(agentId);
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
    return this.skills.prime(agentId, this.deps.machine.get(), () =>
      this.deps.machine.refreshSkills(agentId),
    );
  }
}
