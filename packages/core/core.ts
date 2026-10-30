import { LumiscaDb } from "./db/mod.ts";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ClientEvent } from "./types/event.ts";
import type { SessionInfo } from "./types/session.ts";
import type { Workspace } from "./types/workspace.ts";
import {
  createFileSettingsRepo,
  createInMemorySettingsRepo,
  type SettingsRepo,
} from "./settings/repo.ts";
import { resolveSettingsPath } from "./settings/path.ts";
import {
  type ConnectionEntry,
  parseConnections,
} from "./settings/connections.ts";
import { assertNotProtected, filterExposedSettings } from "./settings/guard.ts";
import {
  createWebSearchSettingsStore,
  type FetchLike,
} from "./websearch/mod.ts";
import { WebSearchService } from "./websearch/service.ts";
import type { WebSearchSettingsView, WebSearchTestView } from "./shared/mod.ts";
import { createDbCredentialStore, setApiKey } from "./settings/credentials.ts";
import type { CredentialStore, Provider } from "./ai/types.ts";
import type {
  Api,
  AuthCheck,
  AuthInteraction,
  AuthType,
  ImageContent,
  Model,
} from "./ai/types.ts";
import type { ModePrompt } from "./types/mode-message.ts";
import { ModelManager } from "./models/mod.ts";
import type { EnvReader } from "./models/custom.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./models/user-providers.ts";
import { isThinkingLevel } from "./models/thinking.ts";
import type { ThinkingLevel } from "./shared/mod.ts";
import type { AskAnswer } from "./shared/mod.ts";
import type { TaskInfo, TodoPhase } from "./shared/mod.ts";
import type { CommandApproval } from "./shared/mod.ts";
import type { CompactionPolicyInput } from "./shared/mod.ts";
import type { BackgroundCommandInfo } from "./tools/background.ts";
import type { PendingQuestion } from "./tools/ask.ts";
import {
  APP_MODE_KEY,
  type AppMode,
  COMPUTER_USE_ENABLED_KEY,
  CONNECTIONS_KEY,
  formatSessionName,
  isAppMode,
  LANGUAGE_KEY,
  type Locale,
  parseCompactionPolicyInput,
  resolveLocale,
  type SavedPrompt,
} from "./shared/mod.ts";
import { systemLanguageTags } from "./locale.ts";
import { CoreError } from "./errors.ts";
import { createWorkspaceRepo } from "./workspace/repo.ts";
import { WorkspaceService } from "./workspaces.ts";
import { PersonalizationService } from "./personalization.ts";
import { SavedPromptsService } from "./saved-prompts.ts";
import { createSessionRepo, type SessionRepo } from "./session/repo.ts";
import { createMessageRepo, type MessageRepo } from "./session/messages.ts";
import { SessionVisualStore, VISUALS_DIR_NAME } from "./session/visuals.ts";
import {
  createRequestShapeRepo,
  type RequestShapeRepo,
} from "./session/request-shapes.ts";
import type { SessionAgent } from "./agent/session-agent.ts";
import { SessionPool } from "./agent/pool.ts";
import { withProviderRetryDefaults } from "./agent/llm-retry.ts";
import {
  buildChatSystemPrompt,
  buildStellaSystemPrompt,
  buildSystemPrompt,
} from "./tools/mod.ts";
import { runVmCommand, runVmCommandBytes } from "./vm/command.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./vm/command.ts";
import {
  createVmExec,
  createVmExecBytes,
  type VmExec,
  type VmExecBytes,
  type VmManager,
  type VmProgress,
} from "./vm/container.ts";
import {
  type StellaAvailability,
  stellaAvailability,
} from "./vm/availability.ts";
import { createVmScreen } from "./vm/screen.ts";
import { createVmTools } from "./vm/tools.ts";
import { discoverVmSkills } from "./vm/skills.ts";
import type { StellaRuntime } from "./vm/runtime.ts";
import { builtinSkills } from "./skills/builtin/mod.ts";
import {
  type AgentRepo,
  createAgentRepo,
  type StellaAgent,
} from "./stella/agents.ts";
import { createAgentCreateTool } from "./stella/tools.ts";
import { createHistorySearchTool } from "./stella/history.ts";
import {
  createIdentityProvider,
  createIdentityTool,
  type IdentityTarget,
} from "./stella/identity.ts";
import { createRoutineRepo, type RoutineRepo } from "./routine/repo.ts";
import {
  createRoutineScheduler,
  type RoutineRunner,
  type RoutineScheduler,
} from "./routine/scheduler.ts";
import { createRoutineTools } from "./routine/tools.ts";
import { HandoverHub, type PendingHandover } from "./vm/handover.ts";
import { VM_WORKDIR, vmAgentDir } from "./vm/contract.ts";
import { createVmAskUserTool } from "./vm/ask-user.ts";
import { createChatUiTool } from "./tools/chat-ui.ts";
import type { Routine } from "./shared/mod.ts";
import {
  VmBackgroundSpawner,
  VmCommandRunner as VmCommandRunnerImpl,
} from "./vm/shell.ts";
import { VmFileBackend } from "./vm/fs.ts";
import { sessionSkills } from "./tools/toolsets.ts";
import type { SkillDef, SkillInfo } from "./skills/discover.ts";
import { skillInfo } from "./skills/discover.ts";
import type { McpInfo } from "./mcp/config.ts";
import { McpService } from "./mcp/service.ts";
import type { McpTestResult } from "./mcp/service.ts";
import { McpOAuthStore } from "./mcp/oauth.ts";
import type { McpAuthSnapshot } from "./mcp/oauth-session.ts";
import { CommandSafety } from "./safety/command-safety.ts";
import type { BrowserBackend } from "./browser/types.ts";
import type { ComputerHost, ComputerHostResult } from "./computer/types.ts";

export interface CreateSessionInput {
  /** The session's workspace; omitted → a chat session in the folder-less
   * chat workspace ("simple chat" without a workspace picker). */
  workspaceId?: string;
  name?: string;
  /** Omitted → the last-used model (or the first enabled model) is used. */
  modelProvider?: string;
  modelId?: string;
}

/**
 * Root object shared by every frontend (web server, desktop).
 * A thin facade over focused services (settings guard, personalization,
 * saved prompts, workspaces, models, sessions, MCP): orchestration lives
 * here, domain logic lives there.
 *
 * Test seam: `overrides` replaces any collaborator (model manager, pool,
 * MCP service, safety check, repos). Production paths pass nothing and get
 * the default wiring below.
 */
export class LumiscaCore {
  readonly db: LumiscaDb;
  readonly models: ModelManager;

  private readonly settings: SettingsRepo;
  private readonly credentials: CredentialStore;
  private readonly workspaces: WorkspaceService;
  private readonly personalization: PersonalizationService;
  private readonly savedPrompts: SavedPromptsService;
  private readonly sessions: SessionRepo;
  private readonly stellaAgents: AgentRepo;
  /** Routines (scheduled requests) and the scheduler that fires them. The
   * scheduler is created here so tests can drive it with a short tick; the
   * server starts and stops it (see package.json tasks / server/mod.ts). */
  private readonly routines: RoutineRepo;
  private readonly routineScheduler: RoutineScheduler;
  private readonly messages: MessageRepo;
  private readonly requestShapes: RequestShapeRepo;
  private readonly pool: SessionPool;
  private readonly mcp: McpService;
  /** Where the sessions' published visuals live (the images an agent shows
   * inside its reply — see session/visuals.ts). Shared with the session pool
   * (the visual tool publishes here) and read by the server's asset route. */
  private readonly visuals: SessionVisualStore;
  /** MCP OAuth grants (see mcp/oauth.ts), shared with the session pool. */
  private readonly mcpOAuth: McpOAuthStore;
  private readonly commandSafety: CommandSafety;
  /** The web-search setting and the provider built over it. */
  private readonly webSearch: WebSearchService;
  /** Browser-lab backend (Desktop WebView host), or
   * undefined in plain server mode — the agent then gets no browser
   * tools. Attached by the server (server/mod.ts) before sessions open. */
  private browserBackend: BrowserBackend | undefined;
  /** Computer-use host (this machine's screen, mouse and keyboard), or
   * undefined when no host could be attached. Attached by the server
   * (server/mod.ts) before sessions open; whether sessions may actually
   * drive it is the settings toggle (isComputerUseEnabled). */
  private computerHost: ComputerHost | undefined;
  /** Why there is no host on this machine (the platform, a missing
   * display, ...). Reported when the user tries to enable the feature, so
   * the settings dialog can say what is wrong instead of failing silently. */
  private computerUnavailableReason: string | undefined;
  /** Global skills directory override (see SessionPoolDeps): tests pass an
   * empty list so a fixture's skill catalog never depends on the machine
   * the tests run on. */
  private readonly globalSkillDirs: string[] | undefined;
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  /** Per-session count of the events this core has emitted; see
   * getSessionRevision. Entries are dropped with their session. */
  private readonly sessionRevisions = new Map<string, number>();
  /** The stella machine, attached by the server once it knows where the
   * container files live (see setStellaVm). Undefined until then, and in
   * tests — stella mode is unavailable without one, never degraded. */
  private stellaVm: VmManager | undefined;
  /** The availability verdict of the machine, cached until the next status
   * read (see getStellaAvailability). */
  private stellaVerdict: StellaAvailability | undefined;
  /** The exec seams of the attached machine, rebuilt whenever the machine is
   * replaced (never carried across a detach, so a removed machine cannot be
   * reached through a stale reference). */
  private stellaExecCache:
    | { vm: VmManager; exec: VmExec; execBytes: VmExecBytes }
    | undefined;
  /** The stella skill catalog, refreshed before each open (see
   * refreshStellaSkills). */
  private stellaSkills: SkillDef[] = [];
  /** How the machine's commands are run (see StellaRuntime): `podman` in
   * production, an injected stub in tests. */
  private readonly stellaRun:
    | { run: VmCommandRunner; runBytes: VmCommandBytesRunner }
    | undefined;
  /** The in-flight machine start, shared by callers that race on a cold
   * machine (see ensureStellaReady). */
  private stellaStarting: Promise<void> | undefined;
  /** Hand-over hubs per session (see handoverFor). Dropped with the
   * session. */
  private readonly handoverHubs = new Map<string, HandoverHub>();

  private constructor(
    db: LumiscaDb,
    settings: SettingsRepo,
    overrides: {
      models?: ModelManager;
      personalization?: PersonalizationService;
      savedPrompts?: SavedPromptsService;
      sessions?: SessionRepo;
      stellaAgents?: AgentRepo;
      routines?: RoutineRepo;
      /** Tick of the routine scheduler (tests shorten it so a scheduled run
       * fires without waiting half a minute). */
      routineTickMs?: number;
      /** Delay before the scheduler's first tick (tests shorten it too). */
      routineCatchUpDelayMs?: number;
      messages?: MessageRepo;
      requestShapes?: RequestShapeRepo;
      commandSafety?: CommandSafety;
      pool?: SessionPool;
      mcp?: McpService;
      workspaces?: WorkspaceService;
      visuals?: SessionVisualStore;
      globalSkillDirs?: string[];
      /** Environment the model layer reads (custom providers, ambient API
       * keys). Defaults to the real process environment; tests pass their
       * own so they never mutate the process-global one. */
      env?: EnvReader;
      /** Transport of the web-search providers. Tests pass a stub so a key
       * check never reaches the network. */
      webSearchFetch?: FetchLike;
      /** How the stella machine's commands are run (`podman`, in
       * production). Tests pass a stub so the file/skill/screen seams work
       * without a container; production leaves it unset. */
      stellaRun?: {
        run: VmCommandRunner;
        runBytes: VmCommandBytesRunner;
      };
    } = {},
  ) {
    this.globalSkillDirs = overrides.globalSkillDirs;
    this.stellaRun = overrides.stellaRun;
    this.db = db;
    this.settings = settings;
    this.credentials = createDbCredentialStore(this.settings);
    this.models = overrides.models ??
      new ModelManager(this.credentials, this.settings, overrides.env);
    this.personalization = overrides.personalization ??
      new PersonalizationService(this.settings);
    this.savedPrompts = overrides.savedPrompts ??
      new SavedPromptsService(this.settings);
    this.sessions = overrides.sessions ?? createSessionRepo(db);
    this.stellaAgents = overrides.stellaAgents ?? createAgentRepo(db);
    this.routines = overrides.routines ?? createRoutineRepo(db);
    this.routineScheduler = createRoutineScheduler({
      repo: this.routines,
      runner: this.routineRunner(),
      ...(overrides.routineTickMs !== undefined
        ? { tickMs: overrides.routineTickMs }
        : {}),
      ...(overrides.routineCatchUpDelayMs !== undefined
        ? { catchUpDelayMs: overrides.routineCatchUpDelayMs }
        : {}),
    });
    this.messages = overrides.messages ?? createMessageRepo(db);
    this.requestShapes = overrides.requestShapes ??
      createRequestShapeRepo(db);
    const streamFn = withProviderRetryDefaults(
      this.models.models.streamFn((providerId) =>
        this.models.getProviderWithRetired(providerId)
      ),
    );
    this.commandSafety = overrides.commandSafety ??
      new CommandSafety({
        getSetting: (key) => this.settings.get(key),
        setSetting: (key, value) => this.settings.set(key, value),
        getFastModel: () => this.models.getFastModel(),
        streamFn,
      });
    // The web-search configuration lives in the settings file (one JSON
    // entry, see websearch/settings.ts) and the manager turns it into the
    // provider the tools use. Read through the getter on every session open
    // and on every key check, so a change needs no rebuild request.
    this.webSearch = new WebSearchService({
      settings: createWebSearchSettingsStore(this.settings),
      locale: () => this.getLanguage(),
      ...(overrides.webSearchFetch === undefined
        ? {}
        : { fetch: overrides.webSearchFetch }),
    });
    // One store of MCP OAuth grants, shared by the sign-in flow (settings)
    // and the session connections (pool), so a sign-in is immediately what
    // the next connection uses.
    this.mcpOAuth = new McpOAuthStore(this.settings);
    // Visual assets live beside the database (open() passes that root), so a
    // database and the images its sessions showed travel together. An
    // in-memory core has no such directory: it gets a path under the temp
    // directory, which nothing creates until a session actually publishes
    // (SessionVisualStore.put), so a core that never shows an image leaves
    // nothing behind.
    this.visuals = overrides.visuals ??
      new SessionVisualStore(
        join(tmpdir(), `lumisca-visuals-${crypto.randomUUID()}`),
      );
    this.pool = overrides.pool ?? new SessionPool({
      mcpOAuth: this.mcpOAuth,
      requireModel: (provider, modelId) => this.requireModel(provider, modelId),
      getImageAnalysisModel: () => this.models.getImageAnalysisModel(),
      getFastModel: () => this.models.getFastModel(),
      getFastModelInfo: () => this.models.getFastModelInfo(),
      renameSession: (id, name) => this.setSessionName(id, name),
      getThinkingLevel: (provider, modelId) =>
        this.models.getThinkingLevel(provider, modelId),
      getLanguage: () => this.getLanguage(),
      getCompactionPolicy: () => this.getCompactionPolicy(),
      buildGeneratedPrompt: (workspace, model, tools, stella) =>
        this.buildGeneratedPrompt(
          workspace,
          model,
          tools,
          stella === undefined ? false : {
            name: stella.name,
            role: stella.role,
            id: stella.agentId ?? "",
          },
        ),
      personalInstructions: () => {
        const personal = this.personalization.get();
        return personal.path === "" ? undefined : personal;
      },
      updateSystemPrompt: (id, systemPrompt) =>
        this.sessions.updateSystemPrompt(id, systemPrompt),
      streamFn,
      messageRepo: this.messages,
      requestShapeRepo: this.requestShapes,
      loadGoal: (id) => this.sessions.getGoal(id),
      saveGoal: (id, text, maxIterations) => {
        this.sessions.setGoal(id, text, maxIterations);
        const goal = this.sessions.getGoal(id);
        if (!goal) throw new CoreError(`Session not found: ${id}`, "not_found");
        return goal;
      },
      updateGoal: (id, patch) => {
        this.sessions.updateGoal(id, patch);
        return this.sessions.getGoal(id);
      },
      clearGoal: (id) => {
        const goal = this.sessions.getGoal(id);
        this.sessions.clearGoal(id);
        return goal?.text;
      },
      commandSafety: this.commandSafety,
      visuals: this.visuals,
      // Resolved lazily (open) so the circular wiring stays one-way:
      // the pool references the service, the service references the pool
      // via the injected applyMcpConfigChange / agentMcpStatus below.
      loadMergedMcp: (workspace) => this.mcp.loadMergedConfig(workspace),
      requireWorkspace: (id) => this.requireWorkspace(id),
      emit: (event) => this.emit(event),
      browser: () => this.browserBackend,
      computer: () => this.computerHostForSession(),
      webSearch: () => this.webSearch.provider() ?? undefined,
      stellaRuntime: (session) => this.stellaRuntimeFor(session),
      stellaAgentPersona: (session) => {
        const agentId = session.agentId;
        if (agentId === undefined) return undefined;
        const agent = this.stellaAgents.get(agentId);
        return agent === undefined
          ? undefined
          : { name: agent.name, role: agent.role, id: agentId };
      },
      globalSkillDirs: this.globalSkillDirs,
    });
    this.mcp = overrides.mcp ?? new McpService({
      settings: this.settings,
      oauth: this.mcpOAuth,
      listSessions: (workspaceId) => this.sessions.list(workspaceId),
      agentMcpStatus: (sessionId) =>
        this.pool.get(sessionId)?.getMcpStatus() ?? null,
      requireWorkspace: (id) => this.requireWorkspace(id),
      applyMcpConfigChange: (sessions, mutate) =>
        this.pool.applyMcpConfigChange(sessions, mutate),
      refreshSessionMcp: (sessions) => this.pool.refreshMcp(sessions),
    });
    this.workspaces = overrides.workspaces ??
      new WorkspaceService(createWorkspaceRepo(db), {
        listSessions: (workspaceId) => this.sessions.list(workspaceId),
        applyChange: (sessions, mutate) =>
          this.pool.applyChange(sessions, mutate),
        // The core's own delete: deleting a workspace drops its sessions'
        // rows AND their visual assets, exactly like deleting a session
        // directly (the pool alone would leave the assets behind).
        deleteSession: (id) => this.deleteSession(id),
      });
  }

  /** Settings live in ~/.config/lumisca-agent/settings.jsonc by default
   * (see resolveSettingsPath); an explicit settingsPath overrides that.
   * `env` replaces the process environment the model layer reads (see
   * `forTesting`); production leaves it unset. */
  static open(
    dbPath: string,
    settingsPath: string = resolveSettingsPath(),
    env?: EnvReader,
  ): LumiscaCore {
    return new LumiscaCore(
      LumiscaDb.open(dbPath),
      createFileSettingsRepo(settingsPath),
      {
        env,
        // The visual assets sit beside the database file: the same directory
        // the session rows live in, and the one the operator chose with
        // --db.
        visuals: new SessionVisualStore(
          join(dirname(dbPath), VISUALS_DIR_NAME),
        ),
      },
    );
  }

  static openInMemory(): LumiscaCore {
    return new LumiscaCore(
      LumiscaDb.openInMemory(),
      createInMemorySettingsRepo(),
    );
  }

  /** Test-only: in-memory core with extra providers (e.g. the faux
   * provider). Global skill discovery is disabled: a test's skill catalog
   * must come from its own fixture, never from the machine running it (the
   * developer's `~/.agents/skills` would otherwise change what the model
   * sees).
   *
   * The model layer reads its environment through `env`, which defaults to
   * EMPTY. `Deno.env` is global to the whole test process (the runner runs
   * every test file in one process, in parallel worker threads), so reading
   * it would make a test depend on the machine — and on whatever another
   * file happened to set at that moment. A test that wants ambient
   * variables passes them explicitly.
   *
   * `stellaRun` replaces the machine's command runner, so a test can give a
   * stella session a skill directory (and any other exec-driven seam)
   * without a container. Production never passes it. */
  static forTesting(
    extraProviders: Provider[] = [],
    env: EnvReader = () => ({}),
    stellaRun?: { run: VmCommandRunner; runBytes: VmCommandBytesRunner },
  ): LumiscaCore {
    const core = new LumiscaCore(
      LumiscaDb.openInMemory(),
      createInMemorySettingsRepo(),
      {
        globalSkillDirs: [],
        env,
        ...(stellaRun !== undefined ? { stellaRun } : {}),
      },
    );
    for (const provider of extraProviders) {
      core.models.models.setProvider(provider);
    }
    return core;
  }

  /** Shut the core down: stop every session's background commands,
   * close every session (killing their MCP server processes) and close
   * the database. Resolves once every background kill has taken effect
   * and every child process is dead, so callers that delete workspace
   * folders afterwards must await it (on Windows a live child running
   * with the folder as its working directory blocks deletion). */
  async close(): Promise<void> {
    // The timers first: a tick that fires while the sessions are closing
    // would try to start a run on a pool that is shutting down.
    this.routineScheduler.close();
    await this.pool.closeAll();
    // The machine is this application's; leaving it running would keep a
    // container (and a memory-hungry desktop inside it) alive after the app
    // that owns it is gone. A stop that fails is logged by the server's
    // shutdown path, not swallowed here.
    if (this.stellaVm !== undefined) await this.stellaVm.stop();
    this.db.close();
  }

  // --- routines (scheduled requests) ---------------------------------------

  /** The routine repository (the settings list reads it). */
  getRoutineRepo(): RoutineRepo {
    return this.routines;
  }

  /** Start the routine scheduler. The server calls this once the rest of the
   * app is up; tests drive `runNow` / a short tick instead. */
  startRoutines(): void {
    this.routineScheduler.start();
  }

  stopRoutines(): void {
    this.routineScheduler.close();
  }

  /** Whether a run of this routine is in flight (the settings list's
   * "running now"). Never persisted: it describes this process. */
  isRoutineRunning(id: string): boolean {
    return this.routineScheduler.isRunning(id);
  }

  /** Run a routine now, without moving its schedule. Resolves when the run
   * finished (the HTTP route does not wait — see routes). */
  runRoutineNow(id: string): Promise<void> {
    return this.routineScheduler.runNow(id);
  }

  /** Stop a running routine's run. Only the run this routine started is
   * interrupted; a user's own run in the same conversation is left alone. */
  stopRoutine(id: string): void {
    this.routineScheduler.stop(id);
  }

  /** The routines of one agent, oldest first (the settings list, the tool
   * list). */
  listRoutinesOf(agentId: string): Routine[] {
    return this.routines.listOf(agentId);
  }

  /** The scheduler's seam into the sessions: start a routine's run in its
   * agent's conversation and wait for it, and stop the run it started. */
  private routineRunner(): RoutineRunner {
    return {
      isRunning: (agentId) => {
        const session = this.sessions.getByAgent(agentId);
        if (session === undefined) return false;
        const agent = this.pool.get(session.id);
        return agent !== undefined && agent.isStreaming;
      },
      run: async (agentId, prompt, routine) => {
        const session = this.sessions.getByAgent(agentId);
        if (session === undefined) {
          // The agent exists but its conversation was never opened, or it
          // was deleted while the run was queued: opening it here would
          // resurrect a deleted agent's row, so this is a real failure.
          throw new CoreError(
            `No conversation to run the routine in (agent ${agentId})`,
            "not_found",
          );
        }
        await this.openSession(session.id);
        const agent = this.pool.require(session.id);
        this.sessions.touch(session.id);
        return await agent.runRoutine(prompt, {
          id: routine.id,
          name: routine.name,
        });
      },
      stop: (agentId, routineId) => {
        const session = this.sessions.getByAgent(agentId);
        if (session === undefined) return;
        const agent = this.pool.get(session.id);
        if (agent === undefined) return;
        // Only the run this routine started is stopped: a run the user
        // started in the same conversation must not be cut by a routine's
        // stop button.
        if (agent.runningRoutineId() !== routineId) return;
        agent.abort();
      },
    };
  }

  // --- browser lab --------------------------------------------------------

  /** Attach (or detach, with undefined) the browser-lab backend. The
   * seeded browser tools resolve the backend at execute time, so a
   * replacement applies to open sessions too; a detach fails their next
   * browser call with a clear error and removes the tools from sessions
   * rebuilt from now on. The desktop shell passes its IPC endpoint; plain
   * server mode passes nothing (no browser tools). */
  setBrowserBackend(backend: BrowserBackend | undefined): void {
    this.browserBackend = backend;
  }

  /** The attached browser backend, if any. */
  getBrowserBackend(): BrowserBackend | undefined {
    return this.browserBackend;
  }

  // --- computer use (this machine's screen, mouse and keyboard) ------------

  /** Attach (or detach, with an unavailable result) the computer-use host.
   * The server does this once at startup; the seeded tools resolve the host
   * at execute time, so a later detach fails their next call with a clear
   * error. Whether sessions may use it at all is the settings toggle — see
   * setComputerUseEnabled. */
  setComputerHost(result: ComputerHostResult): void {
    this.computerHost = result.available ? result.host : undefined;
    this.computerUnavailableReason = result.available
      ? undefined
      : result.reason;
  }

  /** The attached host, if this machine has one (regardless of the toggle). */
  getComputerHost(): ComputerHost | undefined {
    return this.computerHost;
  }

  /** Whether the user enabled computer use (the settings toggle; "1" = on,
   * anything else = off, including unset — the feature is opt-in because a
   * run can click and type anywhere on the machine). */
  isComputerUseEnabled(): boolean {
    return this.settings.get(COMPUTER_USE_ENABLED_KEY) === "1";
  }

  /** Enable or disable computer use (the settings toggle). The flag decides
   * which tools every session gets, so the open sessions are rebuilt — the
   * same contract as every other capability change (refused with `conflict`
   * while a session is streaming). Enabling on a machine without a host
   * throws `unavailable` with that machine's reason: accepting the toggle
   * there would advertise tools that cannot run. */
  setComputerUseEnabled(enabled: boolean): void {
    if (enabled && this.computerHost === undefined) {
      throw new CoreError(
        this.computerUnavailableReason ??
          "computer use is not available on this machine",
        "unavailable",
      );
    }
    this.pool.applyChange(this.sessions.list(), () => {
      this.settings.set(COMPUTER_USE_ENABLED_KEY, enabled ? "1" : "");
    });
  }

  /** The host a session may drive: attached only when this machine has one
   * AND the user enabled the feature. Read at agent open (which tools a
   * session gets) and at every tool call, so disabling stops an
   * already-seeded session on its next call. */
  private computerHostForSession(): ComputerHost | undefined {
    return this.isComputerUseEnabled() ? this.computerHost : undefined;
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ClientEvent): void {
    // One choke point for every session event (the agent, the ask/todo
    // hubs, the background manager and the task hub all emit through here),
    // so the revision below counts each of them exactly once.
    if ("sessionId" in event) {
      const sessionId = event.sessionId;
      this.sessionRevisions.set(
        sessionId,
        (this.sessionRevisions.get(sessionId) ?? 0) + 1,
      );
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore sink failures
      }
    }
  }

  /** How many events this server has emitted for the session over the life
   * of the process (0 when none, or after the session was closed and
   * reopened). The count travels with every frame of the event stream and
   * with the session snapshot, so a client can tell "I have seen
   * everything" from "I missed something": the stream is ordered and
   * reliable while it is up, so a jump in the count means frames were lost,
   * and a count behind the server's means the view is stale. The web's
   * revision probe uses it to re-read the snapshot only when needed (see
   * useSessionEvents).
   *
   * This is a *delivery* check, not a content check: it cannot see state
   * that changed without an event (the snapshot's completeness is what
   * covers those). */
  getSessionRevision(id: string): number {
    return this.sessionRevisions.get(id) ?? 0;
  }

  // --- settings -----------------------------------------------------------

  /** Read a setting. Protected keys (credentials, MCP config) are refused —
   * they have their own APIs and must never be readable through the generic
   * settings surface. */
  getSetting(key: string): string | undefined {
    assertNotProtected(key);
    return this.settings.get(key);
  }

  setSetting(key: string, value: string): void {
    assertNotProtected(key);
    this.settings.set(key, value);
  }

  deleteSetting(key: string): void {
    assertNotProtected(key);
    this.settings.delete(key);
  }

  /** The app language: the stored setting when one was chosen, else the
   * machine's own locale (see shared/i18n and locale.ts). The server
   * resolves the same value per request — its first page load stores the
   * browser's language — so both agree on what "the app language" is.
   *
   * It is read when a session is created (the prompt and the provisional
   * name) and when a session agent is built (the language of the text the
   * core generates into the transcript). */
  getLanguage(): Locale {
    return resolveLocale(this.settings.get(LANGUAGE_KEY), systemLanguageTags());
  }

  /** The compaction tuning stored in the settings table (see
   * shared/settings-keys.ts). Read by the session agents on every
   * compaction check, so a change applies to running sessions without a
   * rebuild; omitted fields keep the compactor's defaults (pi's). */
  getCompactionPolicy(): CompactionPolicyInput {
    return parseCompactionPolicyInput((key) => this.settings.get(key));
  }

  // --- command safety (fast-model judgement of bash/eval) -------------------
  // The enable toggle itself is a plain setting (`command_safety_enabled`);
  // only the approvals record needs dedicated accessors.

  /** The recorded approvals of the safety check, in insertion order. Each
   * entry carries a redacted command for display (never the raw command),
   * so it is safe to surface to the UI. */
  getCommandApprovals(): CommandApproval[] {
    return this.commandSafety.approvals();
  }

  /** Forget one approval by its hash (it is judged again next time). */
  deleteCommandApproval(hash: string): void {
    this.commandSafety.deleteApproval(hash);
  }

  /** Forget every approved command. */
  clearCommandApprovals(): void {
    this.commandSafety.clearApprovals();
  }

  // --- server connection registry (web clients) ---------------------------
  // Shared by web clients so they can switch servers from the settings UI.

  getConnections(): ConnectionEntry[] {
    return parseConnections(this.settings.get(CONNECTIONS_KEY));
  }

  setConnections(entries: ConnectionEntry[]): void {
    this.settings.set(CONNECTIONS_KEY, JSON.stringify(entries));
  }

  /** Non-protected settings only; credentials, MCP config, connection
   * registry and the command-safety approvals record are never exposed
   * through the generic settings surface (each has its own API). */
  listSettings(): Map<string, string> {
    return filterExposedSettings(this.settings.list());
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    await setApiKey(this.credentials, providerId, key);
  }

  /** Run a provider-owned login flow (OAuth) and persist the returned
   * credential. The interaction bridges the flow's prompts/notifications
   * to the UI. Only "oauth" is supported: API keys have their own surface
   * (setProviderApiKey). */
  async loginProvider(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<void> {
    await this.models.login(providerId, type, interaction);
  }

  /** Remove the stored credential for a provider. */
  async logoutProvider(providerId: string): Promise<void> {
    await this.models.logout(providerId);
  }

  // --- personalization (machine-level AGENTS.md) --------------------------

  /** The machine-level AGENTS.md (next to the settings file) with the path
   * it lives at. Absent file → empty content. */
  getPersonalization(): { path: string; content: string } {
    return this.personalization.get();
  }

  /** Replace the machine-level AGENTS.md. Applies to sessions created from
   * now on; existing sessions keep their snapshot. */
  setPersonalization(content: string): void {
    this.personalization.set(content);
  }

  // --- saved prompts (user-defined prompt snippets) -----------------------

  /** All saved prompts, in insertion order. */
  getSavedPrompts(): SavedPrompt[] {
    return this.savedPrompts.list();
  }

  /** Add a saved prompt. Throws when the id already exists. */
  addSavedPrompt(
    input: { id: string; label: string; prompt: string },
  ): SavedPrompt {
    return this.savedPrompts.add(input);
  }

  /** Update a saved prompt's label and/or prompt by id. Throws when the
   * id does not exist. */
  updateSavedPrompt(
    id: string,
    input: { label?: string; prompt?: string },
  ): SavedPrompt {
    return this.savedPrompts.update(id, input);
  }

  /** Delete a saved prompt by id. Throws when the id does not exist. */
  deleteSavedPrompt(id: string): void {
    this.savedPrompts.delete(id);
  }

  // --- app mode and the stella machine -------------------------------------

  /** The stored operating mode, or undefined while the user has not picked
   * one (the client then shows the selection screen). */
  getAppMode(): AppMode | undefined {
    const raw = this.settings.get(APP_MODE_KEY);
    return isAppMode(raw) ? raw : undefined;
  }

  /**
   * Record the operating mode.
   *
   * Switching to stella requires a usable machine: refusing here (rather
   * than accepting the choice and failing later) is what keeps the mode
   * honest — stella mode without its VM has no tools and no purpose, and a
   * failure in the middle of a conversation would be indistinguishable from
   * a bug. Switching away never stops the machine: it takes minutes to
   * build and seconds to boot, and a user flipping to code mode for one task
   * expects to find stella where they left it.
   */
  setAppMode(mode: AppMode): void {
    if (mode === "stella") {
      // The machine must be able to run here at all; whether it is up right
      // now is not this call's business (the first conversation starts it).
      if (this.stellaVm === undefined) {
        throw new CoreError(
          "stella mode is not available: the virtual machine is not set up " +
            "for this installation",
          "unavailable",
        );
      }
    }
    this.settings.set(APP_MODE_KEY, mode);
  }

  /** Attach the stella machine (the server does this at start-up, once it
   * has resolved where the container files live). Detach with undefined. */
  setStellaVm(vm: VmManager | undefined): void {
    this.stellaVm = vm;
    // A new machine invalidates both the cached verdict (an image may have
    // been built since, or podman removed) and the exec seams.
    this.stellaVerdict = undefined;
    this.stellaExecCache = undefined;
    this.stellaSkills = [];
  }

  /** The machine, when one is attached. */
  getStellaVm(): VmManager | undefined {
    return this.stellaVm;
  }

  /** Whether stella mode can run here, with the reason when it cannot. Read
   * from the machine's actual state, so installing podman or building the
   * image takes effect without a restart. */
  async getStellaAvailability(): Promise<StellaAvailability> {
    const availability = this.stellaVm === undefined
      ? {
        available: false as const,
        reason:
          "stella mode is not available: the virtual machine is not set up " +
          "for this installation",
      }
      : stellaAvailability(await this.stellaVm.status());
    // Every read records the verdict: the mode switch depends on one having
    // been made, and this is the call that makes it.
    this.stellaVerdict = availability;
    return availability;
  }

  // --- stella agents (the counterpart of each conversation) ----------------

  /** The agents in the sidebar, most recently used first. */
  listStellaAgents(): StellaAgent[] {
    return this.stellaAgents.list();
  }

  /** The agent a fresh stella screen opens by default: the last one used, or
   * undefined on a first run (the client then offers to make one). */
  defaultStellaAgent(): StellaAgent | undefined {
    return this.stellaAgents.latest();
  }

  /** Create an agent from a name and the role it works from. A name that is
   * already taken is refused (compared case-insensitively: "Researcher" and
   * "researcher" would be two indistinguishable rows in the sidebar). */
  createStellaAgent(input: { name: string; role: string }): StellaAgent {
    const name = input.name.trim();
    if (
      this.stellaAgents.list().some(
        (agent) => agent.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new CoreError(
        `An agent named "${name}" already exists. Choose another name.`,
        "conflict",
      );
    }
    return this.stellaAgents.create(input);
  }

  renameStellaAgent(id: string, name: string): StellaAgent {
    this.stellaAgents.rename(id, name);
    const agent = this.stellaAgents.get(id);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    return agent;
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
    const session = this.sessions.getByAgent(id);
    if (session !== undefined) await this.deleteSession(session.id);
    this.stellaAgents.delete(id);
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
  async getOrCreateStellaSession(agentId?: string): Promise<SessionInfo> {
    const agent = agentId !== undefined
      ? this.stellaAgents.get(agentId)
      : this.stellaAgents.latest();
    if (agent === undefined) {
      throw new CoreError(
        agentId !== undefined
          ? `Agent not found: ${agentId}`
          : "No agent yet: create one before talking to stella",
        "not_found",
      );
    }
    // The machine must be running before an agent is built on it: without one
    // the factory refuses (never a stella agent with host tools). Every
    // caller that wants a conversation wants the machine, so this starts it
    // rather than making the client ask.
    await this.ensureStellaReady();
    // The skill catalog is read from the machine, which the factory cannot
    // await (it builds synchronously): prime it here, before any open.
    await this.refreshStellaSkills();
    // The agent's working folder: bash cannot start in a folder that does
    // not exist (`podman exec --workdir` fails), and a fresh agent has no
    // files yet.
    await this.ensureStellaWorkdir(agent.id);
    this.stellaAgents.touch(agent.id);
    const existing = this.sessions.getByAgent(agent.id);
    if (existing !== undefined) {
      if (this.pool.get(existing.id) === undefined) {
        this.pool.open(
          existing,
          this.requireWorkspace(existing.workspaceId),
          this.messages.listMessages(existing.id),
        );
      }
      return this.decorateSession(this.sessions.get(existing.id) ?? existing);
    }
    const model = await this.resolveDefaultModel(undefined, undefined);
    const workspace = this.getOrCreateChatWorkspace();
    const session = this.sessions.create({
      workspaceId: workspace.id,
      name: agent.name,
      modelProvider: model.provider,
      modelId: model.modelId,
      stella: true,
      agentId: agent.id,
    });
    this.pool.open(session, workspace, []);
    const decorated = this.decorateSession(
      this.sessions.get(session.id) ?? session,
    );
    this.emit({ type: "session_created", session: decorated });
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
    const vm = this.requireStellaVm();
    const availability = stellaAvailability(await vm.status());
    if (!availability.available) {
      throw new CoreError(availability.reason, "unavailable");
    }
    if (this.stellaStarting !== undefined) {
      await this.stellaStarting;
      return;
    }
    const status = await vm.status({ fresh: true });
    if (status.state === "running") {
      this.stellaVerdict = { available: true };
      return;
    }
    const starting = (async () => {
      this.stellaVerdict = undefined;
      try {
        // The manager reports its steps through the sink it was built
        // with; a caller that wants progress passes one at construction
        // (the server does, forwarding it to the client).
        await vm.start();
        void onProgress;
      } finally {
        this.stellaStarting = undefined;
        this.stellaVerdict = undefined;
      }
    })();
    this.stellaStarting = starting;
    await starting;
  }

  /** Whether a machine start is in flight (the status endpoint reports it so
   * a waiting client can say "starting" instead of showing a stale state). */
  isStellaStarting(): boolean {
    return this.stellaStarting !== undefined;
  }

  /**
   * The machine's state.
   *
   * stella's UI shows no machine controls, so this is not a dashboard: it
   * exists for the client to know (a) whether the mode is offerable at all
   * and (b) whether the screen pane can connect. `starting` carries the
   * first-run build, which is the one wait the user does see.
   */
  async getStellaStatus(): Promise<{
    availability: StellaAvailability;
    state: string;
    vncPort: number | null;
    reason: string;
    starting: boolean;
  }> {
    const vm = this.stellaVm;
    if (vm === undefined) {
      const availability = await this.getStellaAvailability();
      return {
        availability,
        state: "unavailable",
        vncPort: null,
        reason: availability.available ? "" : availability.reason,
        starting: false,
      };
    }
    const status = await vm.status({ fresh: true });
    const availability = stellaAvailability(status);
    this.stellaVerdict = availability;
    return {
      availability,
      state: status.state,
      vncPort: status.vncPort,
      reason: status.reason,
      starting: this.isStellaStarting(),
    };
  }

  /** Stop the machine (`podman stop`). Called on shutdown only: the UI has no
   * stop button, because a machine that disappears when the user is not
   * looking costs minutes to bring back. */
  async stopStellaVm(): Promise<void> {
    await this.stellaVm?.stop();
    this.stellaVerdict = undefined;
  }

  /** The hand-over hub of one session (see vm/handover.ts): created on
   * first use and dropped on close, so a torn-down session leaves nothing
   * waiting. */
  private handoverFor(sessionId: string): HandoverHub {
    const existing = this.handoverHubs.get(sessionId);
    if (existing !== undefined) return existing;
    const hub = new HandoverHub(sessionId, (event) => this.emit(event));
    this.handoverHubs.set(sessionId, hub);
    return hub;
  }

  /** The pending hand-over of a session (the resync snapshot carries it so a
   * client that reconnects while the run is blocked can take over). */
  getPendingHandover(sessionId: string): PendingHandover | null {
    return this.pool.get(sessionId)?.getPendingHandover() ?? null;
  }

  /** The user finished at the screen: let the blocked run continue. */
  finishHandover(sessionId: string, note: string, toolCallId?: string): void {
    const agent = this.pool.require(sessionId);
    agent.finishHandover(note, toolCallId);
  }

  /** The exec seam of the attached machine: how the file, shell and screen
   * backends reach inside it. Undefined without a machine. */
  private stellaExec(): VmExec | undefined {
    return this.stellaSeams()?.exec;
  }

  private stellaExecBytes(): VmExecBytes | undefined {
    return this.stellaSeams()?.execBytes;
  }

  /** The exec seams of the attached machine, created on first use. */
  private stellaSeams():
    | { exec: VmExec; execBytes: VmExecBytes }
    | undefined {
    const vm = this.stellaVm;
    if (vm === undefined) return undefined;
    if (this.stellaExecCache?.vm !== vm) {
      this.stellaExecCache = {
        vm,
        exec: createVmExec({
          run: this.stellaRun?.run ?? runVmCommand,
        }),
        execBytes: createVmExecBytes({
          runBytes: this.stellaRun?.runBytes ?? runVmCommandBytes,
        }),
      };
    }
    return this.stellaExecCache;
  }

  /**
   * The runtime a stella session's tools run on, or undefined for every
   * other session.
   *
   * Built per open (never cached across opens): the backends hold no state
   * of their own beyond a `.gitignore` cache, and a machine that was reset
   * between opens must not be reached through a stale seam. The skill catalog
   * is primed synchronously from the last read and refreshed by
   * `refreshStellaSkills` before the session opens — the factory cannot await
   * it (a rebuild happens mid-configuration-change).
   */
  private stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined {
    if (session.stella !== true) return undefined;
    const exec = this.stellaExec();
    const execBytes = this.stellaExecBytes();
    if (exec === undefined || execBytes === undefined) return undefined;
    const skills = (): SkillDef[] => this.stellaSkills;
    // The agent's working folder: relative paths and bash start here, the
    // way a workspace folder does in code mode. It is a default place, not a
    // boundary — the file backend's root is the machine's home, so one agent
    // can reach another's folder when the user asks (see vm/fs.ts).
    const cwd = session.agentId === undefined
      ? VM_WORKDIR
      : vmAgentDir(session.agentId);
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
    const identity: IdentityTarget = {
      read: () => this.stellaAgents.get(agentId)?.identity ?? "",
      write: (content) => this.stellaAgents.writeIdentity(agentId, content),
    };
    return {
      cwd,
      files: new VmFileBackend(exec, { cwd }),
      runner: new VmCommandRunnerImpl(exec),
      backgroundSpawner: new VmBackgroundSpawner(exec),
      skills,
      refreshSkills: async () => {
        this.stellaSkills = await this.readStellaSkills();
      },
      screenTools: [
        ...createVmTools({ screen: createVmScreen({ exec, execBytes }) }),
        createVmAskUserTool({
          handover: this.handoverFor(session.id),
        }),
      ],
      chatUiTool: createChatUiTool(),
      handoverHub: this.handoverFor(session.id),
      routineTools: createRoutineTools({
        repo: this.routines,
        scheduler: this.routineScheduler,
        agentId: session.agentId ?? "",
      }),
      // The tool goes through the same entry point as the API, so the
      // duplicate-name rule is enforced once.
      agentTool: createAgentCreateTool({
        create: (input) => this.createStellaAgent(input),
      }),
      // The history of THIS conversation: each stella agent has its own
      // transcript, so the tool is built per open around the session's rows.
      historyTool: createHistorySearchTool({
        messages: (window) => this.messages.listBetween(session.id, window),
      }),
      // The identity belongs to this agent: the tool writes it, and the
      // provider publishes what was written as a context message, so the
      // snapshotted system prompt never has to change.
      identityTool: createIdentityTool(identity),
      identityProvider: createIdentityProvider(identity),
    };
  }

  /** Create the agent's working folder inside the machine (idempotent).
   * Called when its conversation opens, so the first bash call has a place
   * to start. A machine that is not running is not an error here: the open
   * path already required it, and a failure would only hide the real one. */
  private async ensureStellaWorkdir(agentId: string): Promise<void> {
    const exec = this.stellaExec();
    if (exec === undefined) return;
    await exec(["mkdir", "-p", "--", vmAgentDir(agentId)], {
      timeoutMs: 30_000,
    });
  }

  /** Re-read the stella skill catalog (the machine's own skills plus the
   * user's global and built-in set). Awaited before a stella session opens,
   * so the agent's skill tool starts with a current list. */
  async refreshStellaSkills(): Promise<void> {
    this.stellaSkills = await this.readStellaSkills();
  }

  private async readStellaSkills(): Promise<SkillDef[]> {
    const exec = this.stellaExec();
    if (exec === undefined) return [];
    return await discoverVmSkills({
      exec,
      builtinSkills: builtinSkills({
        // The machine has its own browser and no host computer surface: the
        // built-in guides are chosen accordingly.
        browser: false,
        computer: false,
      }),
      ...(this.globalSkillDirs !== undefined
        ? { globalDirs: this.globalSkillDirs }
        : {}),
    });
  }

  /** The machine, or the reason there is none (a caller that must not
   * silently continue). */
  private requireStellaVm(): VmManager {
    if (this.stellaVm === undefined) {
      throw new CoreError(
        "stella mode is not available: the virtual machine is not set up for " +
          "this installation",
        "unavailable",
      );
    }
    return this.stellaVm;
  }

  // --- workspaces (delegated to WorkspaceService) -------------------------

  async createWorkspace(name: string, folders: string[]): Promise<Workspace> {
    return await this.workspaces.create(name, folders);
  }

  /** The user-facing workspace list. The folder-less chat workspace is an
   * internal singleton (created on first chat session): it is excluded so
   * every client — web UI, API consumers, federated peers — only sees
   * workspaces they can actually manage. Chat sessions are started without
   * a workspaceId instead of by picking this workspace. */
  listWorkspaces(): Workspace[] {
    return this.workspaces.list();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  /** Update a workspace (name and/or folders); running sessions get rebuilt
   * tools when the folders change. Returns the updated workspace. Throws
   * `conflict` while a session in the workspace is streaming. */
  async updateWorkspace(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace> {
    return await this.workspaces.update(id, input);
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.workspaces.delete(id);
  }

  /** Resolve a model or throw `not_found` (single home for the
   * "Model not found" guard every model-taking path shares). Retired
   * models (removed upstream, kept for existing sessions) still resolve
   * here so those sessions keep opening; new-session pickers and
   * `setSessionModel` validate through `getModel` instead and never see
   * them. */
  private requireModel(provider: string, modelId: string): Model<Api> {
    const model = this.models.getModelWithRetired(provider, modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${provider}/${modelId}`,
        "not_found",
      );
    }
    return model;
  }

  /** The folder-less chat workspace ("simple chat" without a workspace),
   * created on first use. Every chat session (createSession without a
   * workspaceId) lives here; the workspace itself is not user-manageable
   * (update/delete are refused). */
  private getOrCreateChatWorkspace(): Workspace {
    return this.workspaces.getOrCreateChatWorkspace();
  }

  // --- web search -----------------------------------------------------------

  /** The web-search setting, as the settings screen shows it: which
   * providers are configured, which one search uses, and which can still be
   * added. Keys never leave this process; only whether one is stored. */
  getWebSearchSettings(): WebSearchSettingsView {
    return this.webSearch.view();
  }

  /** Add a search provider. The first one becomes the default, so a user who
   * adds one provider has working search without a second step. */
  addWebSearchProvider(
    input: { id: string; apiKey: string },
  ): WebSearchSettingsView {
    return this.webSearch.add(input);
  }

  /** Replace one provider's key; an empty key keeps the stored one. */
  updateWebSearchProvider(
    id: string,
    input: { apiKey: string },
  ): WebSearchSettingsView {
    return this.webSearch.update(id, input);
  }

  /** Remove a provider (the default moves to the next one when it was the
   * default). */
  removeWebSearchProvider(id: string): WebSearchSettingsView {
    return this.webSearch.remove(id);
  }

  /** Choose the provider search uses; null turns search off. */
  setDefaultWebSearchProvider(id: string | null): WebSearchSettingsView {
    return this.webSearch.setDefault(id);
  }

  /** Search once with a key the user typed, saving nothing (the screen
   * checks before it stores). A failure is the answer, not an exception. */
  testWebSearchProvider(input: {
    id: string;
    apiKey: string | null;
  }): Promise<WebSearchTestView> {
    return this.webSearch.test(input);
  }

  // --- MCP configuration ----------------------------------------------------

  /** The app-level (global) MCP config with live statuses from every open
   * session. Stored in the settings file; applies to all workspaces. */
  getAppMcpInfo(): McpInfo {
    return this.mcp.getAppMcpInfo();
  }

  /** Replace the app-level MCP config (validating first), then rebuild
   * every open session so the new tools take effect. Throws `conflict`
   * while any session is streaming. */
  setAppMcpConfig(text: string): McpInfo {
    return this.mcp.setAppMcpConfig(text);
  }

  /** The workspace's own `.mcp.json` with live statuses from the
   * workspace's open sessions. Read fresh from disk each time, so external
   * edits are reflected here too. */
  getMcpInfo(workspaceId: string): McpInfo {
    return this.mcp.getMcpInfo(workspaceId);
  }

  /** Replace the workspace's `.mcp.json` (validating first), then rebuild
   * every session in the workspace so the new tools take effect. Throws
   * `conflict` while any session is streaming. */
  setMcpConfig(workspaceId: string, text: string): McpInfo {
    return this.mcp.setMcpConfig(workspaceId, text);
  }

  /** One-shot connection test of a single-server config, used by the
   * settings UI before it saves a new server. Reaching the server and
   * listing its tools happens here: the browser cannot spawn the stdio
   * child processes this app owns. */
  testMcpServer(text: string): Promise<McpTestResult> {
    return this.mcp.testServer(text);
  }

  /** Start an interactive OAuth sign-in for one HTTP MCP server (the
   * settings UI's "sign in" flow). `redirectUri` is where the browser is
   * sent back — a path of this server, so the callback reaches the process
   * that holds the PKCE verifier. Resolves once the flow either waits for
   * the browser (the snapshot carries the authorization URL) or fails to
   * start. */
  startMcpAuth(text: string, redirectUri: string): Promise<McpAuthSnapshot> {
    return this.mcp.startAuth(text, redirectUri);
  }

  /** Live state of one sign-in, for the UI's poll. */
  getMcpAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.mcp.getAuth(sessionId);
  }

  /** Abandon a sign-in. False once it is gone (already settled/expired). */
  cancelMcpAuth(sessionId: string): boolean {
    return this.mcp.cancelAuth(sessionId);
  }

  /** Finish the sign-in the browser came back to: `state` names the flow,
   * `code` is exchanged for tokens, an `error` records the authorization
   * server's refusal. Undefined when no sign-in waits on that state. */
  completeMcpAuth(
    input: { state: string; code?: string; error?: string },
  ): Promise<McpAuthSnapshot | undefined> {
    return this.mcp.completeAuth(input);
  }

  // --- sessions -----------------------------------------------------------

  /** The model a new session would get: the last used model of a
   * configured provider, or the first enabled model of a configured one.
   * Null when no model can be resolved — including "no provider is
   * configured at all", in which case the UI leaves the model unset and
   * refuses to start a session (there is nothing that could stream).
   * Includes the model's thinking level so the draft tab can show the
   * right control. */
  async getDefaultModel(): Promise<
    {
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      thinkingLevels: ThinkingLevel[];
    } | null
  > {
    try {
      const model = await this.resolveDefaultModel();
      return {
        ...model,
        ...this.models.thinkingState(
          model.provider,
          model.modelId,
          this.models.getModel(model.provider, model.modelId),
        ),
      };
    } catch {
      return null;
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    // No workspaceId → a chat session in the folder-less chat workspace
    // (created on first use).
    const workspace = input.workspaceId !== undefined
      ? this.requireWorkspace(input.workspaceId)
      : this.getOrCreateChatWorkspace();
    const model = await this.resolveDefaultModel(
      input.modelProvider,
      input.modelId,
    );
    // The system prompt is generated (and persisted) when the session is
    // opened below: it depends on the tool set the session actually gets,
    // which only the agent factory knows.
    const session = this.sessions.create({
      workspaceId: workspace.id,
      // The provisional name is replaced by the title generator right
      // after the first message; it is stored, so it keeps the language it
      // was created with.
      name: input.name ?? formatSessionName(this.getLanguage()),
      modelProvider: model.provider,
      modelId: model.modelId,
    });
    this.pool.open(session, workspace, []);
    // The event carries the decorated session (chat flag etc.), the same
    // shape every other SessionInfo consumer sees — never the raw row.
    // Re-read it: opening generated and persisted the system prompt.
    const decorated = this.decorateSession(
      this.sessions.get(session.id) ?? session,
    );
    this.emit({ type: "session_created", session: decorated });
    return decorated;
  }

  listSessions(workspaceId?: string): SessionInfo[] {
    return this.sessions.list(workspaceId).map((s) => this.decorateSession(s));
  }

  getSession(id: string): SessionInfo | undefined {
    const session = this.sessions.get(id);
    return session ? this.decorateSession(session) : undefined;
  }

  /** The file one of a session's published visuals names, with the content
   * type to serve it as (`GET /api/sessions/:id/visual/:name`). Undefined
   * when the session has no such asset — an unknown name, or one whose file
   * is gone. The store validates the name, so a caller cannot ask for
   * anything outside the session's own directory. */
  resolveSessionVisual(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.visuals.resolve(sessionId, name);
  }

  /** Load a persisted session into memory (restores message history). */
  openSession(id: string): SessionInfo {
    const session = this.sessions.get(id);
    if (!session) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (!this.pool.get(id)) {
      const workspace = this.requireWorkspace(session.workspaceId);
      const messages = this.messages.listMessages(id);
      this.pool.open(session, workspace, messages);
    }
    return this.decorateSession(session);
  }

  async closeSession(id: string): Promise<void> {
    await this.pool.close(id);
    // The session's in-memory state (and with it the revision count) is
    // gone: a client still holding the old count sees a difference and
    // re-reads the snapshot — the right reaction, since the reopened agent
    // starts from what was persisted.
    this.sessionRevisions.delete(id);
  }

  async deleteSession(id: string): Promise<void> {
    // Start the teardown first (its synchronous prefix runs inline),
    // then drop the persisted row synchronously so the session is
    // synchronously gone for callers that do not await.
    const closing = this.pool.delete(id);
    this.sessions.delete(id);
    this.sessionRevisions.delete(id);
    await closing;
    // The published visuals belong to the session: once it is gone nothing
    // can reference them (a message that did is gone too).
    await this.visuals.deleteSession(id);
  }

  getAgent(id: string): SessionAgent | undefined {
    return this.pool.get(id);
  }

  /** The session's current todo plan (the todo tool); empty when the
   * session is not open or has no plan yet. Lets clients restore the
   * progress panel after a WS drop or page reload. */
  getTodo(id: string): TodoPhase[] {
    return this.pool.getTodo(id);
  }

  /** Snapshots of the session's sub-agent tasks (the task tool); empty
   * when the session is not open or has no tasks yet. Restores the tasks
   * panel after a WS drop or page reload. */
  getTasks(id: string): TaskInfo[] {
    return this.pool.getTasks(id);
  }

  /** Snapshots of the session's background commands (the async_bash tool);
   * empty when the session is not open or has no commands yet. Restores
   * the background panel after a WS drop or page reload. */
  getBackground(id: string): BackgroundCommandInfo[] {
    return this.pool.getBackground(id);
  }

  /** The questions the session is still waiting on (the ask tool); empty
   * when nothing is pending. Read with the transcript by the resync
   * snapshot so a client that (re)connects while a run is blocked on an
   * ask can still answer it (question events are never replayed). */
  getPendingQuestions(id: string): PendingQuestion[] {
    return this.pool.getPendingQuestions(id);
  }

  /** The skills a session in this workspace would get: the same discovery
   * the agent's skill tool and the skill catalog provider run
   * (sessionSkills), so the composer's `/skill` palette lists exactly what
   * the agent can load — including the browser gate of the built-in skills.
   * Omitted `workspaceId` lists a chat session's skills (global and
   * built-in only), the same "omitted → chat" contract as createSession. */
  listSkills(workspaceId?: string): SkillInfo[] {
    const folders = workspaceId === undefined
      ? []
      : this.requireWorkspace(workspaceId).folders;
    return sessionSkills(folders, {
      browserAvailable: this.browserBackend !== undefined,
      computerAvailable: this.computerHostForSession() !== undefined,
      globalDirs: this.globalSkillDirs,
    }).map(skillInfo);
  }

  /** The stella conversation's skill catalog: what its agent can actually
   * load (the machine's own skills, the user's global set, the built-ins).
   * Separate from `listSkills` because the machine's skills do not exist on
   * this machine's disk — a workspace lookup would answer a different
   * question. */
  listStellaSkills(): SkillInfo[] {
    return this.stellaSkills.map(skillInfo);
  }

  /** The session's active goal (`/goal` mode), if any. Persisted in the
   * sessions table so a reopened session shows it again via the resync
   * endpoint; the right-side panel renders it while present. */
  getGoal(id: string): import("./shared/goal.ts").GoalInfo | undefined {
    return this.sessions.getGoal(id);
  }

  /** Cancel the session's active goal (the panel's cancel button). Clears
   * the persisted goal and stops the agent's loop; no-op when no goal
   * runs. The agent emits `goal_done` so the panel clears. */
  cancelGoal(id: string): void {
    this.pool.require(id).cancelGoal();
    this.sessions.touch(id);
  }

  /** The last failure of a session, if any. Cleared when a new run starts.
   * Lets non-WebSocket clients (curl, the desktop shell) learn about
   * failures of fire-and-forget prompts instead of losing them. */
  getSessionLastError(id: string): string | undefined {
    return this.pool.lastError(id);
  }

  /** Fire-and-forget prompt: completion and failures arrive as events
   * (agent_end / session_error). The HTTP layer should use this instead of
   * holding a connection open for the whole run. `images` (base64) are
   * attached to the user message for vision-capable models. While the
   * session is streaming the prompt is steered into the running loop
   * (processed at the next turn boundary) instead of being refused.
   * `mode` (optional) marks the prompt as generated by an agent mode:
   * the transcript then stores a ModeMessage (short text + badge in the
   * UI) instead of a plain user message. */
  startPrompt(
    id: string,
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
  ): void {
    const agent = this.pool.require(id);
    this.sessions.touch(id);
    agent.promptWhileRunning(text, images, mode);
  }

  abort(id: string): void {
    this.pool.require(id).abort();
  }

  /** Resolve a pending ask (the ask tool) of a session with the user's
   * answers, letting the blocked run continue. Throws when the session is
   * closed, the ask is gone (answered or cancelled), or the answers do not
   * match the pending questions. */
  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void {
    this.pool.require(id).answerQuestion(toolCallId, answers);
  }

  /** Undo the transcript from a user message onward (see
   * SessionAgent.rewind): an active run is aborted first. Resolves once
   * the truncation is complete (memory + database). */
  async rewind(id: string, timestamp: number): Promise<void> {
    const agent = this.pool.require(id);
    this.sessions.touch(id);
    await agent.rewind(timestamp);
  }

  /** Condense the session's older history into a checkpoint on demand (the
   * `/compact [instructions]` command), even below the automatic pressure
   * threshold. `instructions` is the user's extra focus for the summary.
   * Returns how many messages were summarized, or undefined when nothing
   * could be condensed (no safe span, or the summarization failed — the
   * transcript is unchanged either way). */
  async compactSession(
    id: string,
    instructions?: string,
  ): Promise<number | undefined> {
    const agent = this.pool.require(id);
    this.sessions.touch(id);
    const result = await agent.compactNow(instructions);
    return result?.summarized.length;
  }

  /** Switch the model used by a session (persisted). Retired models
   * (removed upstream, kept for existing sessions) cannot be newly
   * selected. Throws `conflict` while the session is streaming (rebuilding
   * a live agent would orphan the running loop). */
  setSessionModel(id: string, provider: string, modelId: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (this.models.getModel(provider, modelId) === undefined) {
      throw new CoreError(
        `Model not found: ${provider}/${modelId}`,
        "not_found",
      );
    }
    this.pool.applyChange(
      [{ ...session, modelProvider: provider, modelId }],
      () => {
        this.sessions.updateModel(id, provider, modelId);
      },
    );
  }

  /** Rename a session (persisted) and notify clients, so open tabs show
   * the new title. The single path for every rename (auto-generated
   * titles and any future manual rename). */
  setSessionName(id: string, name: string): void {
    this.sessions.rename(id, name);
    this.emit({ type: "session_renamed", sessionId: id, name });
  }

  /** The thinking level stored for a model (the level its sessions use). */
  getModelThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
    return this.models.getThinkingLevel(providerId, modelId);
  }

  /** Set the thinking level of a model (persisted, per model). Open
   * sessions using the model pick the change up in place from their next
   * run onward — the agent is not rebuilt, so this never throws `conflict`
   * while a session is streaming. The in-flight run keeps the level it
   * started with; newly created sessions use the new level from the start.
   * Returns the level that will actually be used (unsupported requests are
   * clamped). */
  setModelThinkingLevel(
    providerId: string,
    modelId: string,
    level: string,
  ): ThinkingLevel {
    if (!isThinkingLevel(level)) {
      throw new CoreError(
        `Unknown thinking level: ${level}`,
        "invalid",
      );
    }
    this.requireModel(providerId, modelId);
    const effective = this.models.setThinkingLevel(providerId, modelId, level);
    for (const session of this.sessions.list()) {
      if (
        session.modelProvider === providerId && session.modelId === modelId
      ) {
        this.pool.setThinkingLevel(session.id, effective);
      }
    }
    return effective;
  }

  // --- model enablement ----------------------------------------------------

  /** Providers with their models; the settings UI uses this to render
   * pickers. */
  listProviders(): readonly Provider[] {
    return this.models.getProviders();
  }

  listModels(providerId?: string): readonly Model<Api>[] {
    return this.models.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  /** Whether a provider's credentials are complete. */
  async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return await this.models.checkAuth(providerId);
  }

  /** Which credential method a provider accepts ("oauth", "api_key"), or
   * undefined for providers with only ambient auth (env vars etc.).
   * Static provider metadata — no credential required — so the settings UI
   * can offer a login button even before anything is configured. */
  getProviderAuthType(
    providerId: string,
  ): "oauth" | "api_key" | undefined {
    const provider = this.models.getProvider(providerId);
    if (!provider) return undefined;
    if (provider.auth.oauth) return "oauth";
    if (provider.auth.apiKey) return "api_key";
    return undefined;
  }

  /** Local (network-free) auth check: env var or stored key resolves.
   * This is the runtime capability check (can requests actually be
   * made); it deliberately includes ambient env auth, so it must not be
   * used to decide what the UI lists as configured — see
   * `hasConfiguredAuth`. */
  async hasProviderAuth(providerId: string): Promise<boolean> {
    return await this.models.hasProviderAuth(providerId);
  }

  /** Whether the provider is set up inside Lumisca itself: a stored API
   * key / OAuth credential, or a custom provider from Lumisca's own config
   * (models.json / LUMISCA_* env vars, a user-defined provider) whose auth
   * resolves. Ambient machine auth that the SDK happens to find — e.g.
   * ANTHROPIC_API_KEY or HF_TOKEN set for other tools — does NOT count:
   * providers must not appear as "added" just because an env var exists.
   * Also the gate for the default-model resolution and the UI's send
   * buttons: what the settings list calls "設定済み" must be exactly what
   * can be used. */
  async hasConfiguredAuth(providerId: string): Promise<boolean> {
    return await this.models.hasConfiguredAuth(providerId);
  }

  /** Enable or disable a model for the UI. Disabled models are hidden
   * from model pickers. Enabled is the default (nothing stored). */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    this.models.setModelEnabled(providerId, modelId, enabled);
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.models.isModelEnabled(providerId, modelId);
  }

  /** Models of a provider with enablement info, for the settings UI. */
  listModelsDetailed(providerId: string): Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxInputTokens?: number;
    reasoning?: boolean;
    input?: string[];
    enabled: boolean;
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  }> {
    return this.models.getModels(providerId).map((m) => ({
      ...this.models.describeModel(m),
      enabled: this.isModelEnabled(providerId, m.id),
      ...this.models.thinkingState(providerId, m.id, m),
    }));
  }

  // --- user-defined OpenAI-compatible providers ----------------------------

  /** Every user-defined OpenAI-compatible provider (settings UI list).
   * The API key is never included — `hasApiKey` reports whether one is set. */
  async listUserProviders(): Promise<UserProviderSummary[]> {
    return await this.models.listUserProviders();
  }

  /** A single user-defined provider config (prefilling the edit form), or
   * undefined when it does not exist. */
  getUserProvider(id: string): UserProviderConfig | undefined {
    return this.models.getUserProvider(id);
  }

  /** Create a user-defined OpenAI-compatible provider. Validates, persists,
   * and registers it; an `apiKey` in the input is stored in the credential
   * store. Returns the summary. */
  async addUserProvider(
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    return await this.models.addUserProvider(input);
  }

  /** Update a user-defined provider (id fixed by the route, matching the
   * path). An `apiKey` of "" clears the stored key; omitted leaves it. */
  async updateUserProvider(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    return await this.models.updateUserProvider(id, input);
  }

  /** Remove a user-defined provider and its stored API key. */
  async removeUserProvider(id: string): Promise<void> {
    await this.models.removeUserProvider(id);
  }

  /** Whether the provider was added by the user (the settings UI)
   * rather than built in or from the env/models.json custom config. */
  isUserProvider(id: string): boolean {
    return this.models.isUserProvider(id);
  }

  // --- model catalog (models.dev live sync) -------------------------------

  /** Where the active built-in model catalog came from (live fetch, disk
   * cache, or the bundled snapshot). */
  getModelCatalogStatus(): import("./models/mod.ts").CatalogStatus {
    return this.models.getCatalogStatus();
  }

  /** Refresh the built-in model catalog from models.dev (`live → cache →
   * snapshot`). Non-blocking by design: callers fire and forget at startup
   * and await it from the manual refresh UI/API. Never throws — the
   * resolved status (including `error`) is always returned. */
  refreshModelCatalog(
    options: {
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
      baseUrl?: string;
    } = {},
  ): Promise<import("./models/mod.ts").CatalogStatus> {
    return this.models.refreshCatalog(options);
  }

  // --- internals ----------------------------------------------------------

  private requireWorkspace(id: string): Workspace {
    return this.workspaces.require(id);
  }

  /** The generated system prompt for a workspace: who the agent is, the
   * folders it may touch, the machine it runs on, and the guidelines of the
   * tools it has. Chat workspaces (folder-less, "simple chat") get the chat
   * variant instead — no workspace framing, matching their tool set.
   * `model` fills in the environment section's model line; `tools` are the
   * session's preloaded tool names, which decide which guideline sections
   * render. Workspace instructions (AGENTS.md) and the machine-level
   * personal instructions are NOT part of this string: they are published
   * as dynamic context messages (see agent/context-providers), so an edit
   * reaches a session that is already open. */
  private buildGeneratedPrompt(
    workspace: Workspace,
    model?: { provider: string; modelId: string },
    tools: readonly string[] = [],
    stella: boolean | { name: string; role: string; id: string } = false,
  ): string {
    const resolved = model
      ? {
        ...model,
        name: this.models.getModel(model.provider, model.modelId)?.name,
      }
      : undefined;
    // The language is resolved once, here: the prompt is snapshotted with
    // the session, so the session keeps the language it started in even
    // after the setting changes (see tools/language.ts).
    const language = this.getLanguage();
    // stella's conversation row shares the folder-less chat workspace, but
    // its prompt is the machine's: a chat prompt would tell it it cannot
    // run anything, which is the opposite of what it can do.
    if (stella !== false) {
      return buildStellaSystemPrompt({
        tools,
        model: resolved,
        language,
        ...(stella === true ? {} : {
          agent: { name: stella.name, role: stella.role },
          workdir: vmAgentDir(stella.id),
        }),
      });
    }
    return workspace.chat
      ? buildChatSystemPrompt({ tools, model: resolved, language })
      : buildSystemPrompt(workspace, { tools, model: resolved, language });
  }

  /** Resolve the model for a new session: explicit choice, else the
   * last-used model, else the first enabled model of the first configured
   * provider. Provider configuration is load-bearing here: a model whose
   * provider is not set up inside Lumisca cannot stream, so it is never
   * auto-selected — that gates both the last-used path (a key removed
   * since the session ran must not resurrect it as the default) and the
   * fallback (see `ModelManager.getFallbackModel`). Retired models
   * (removed upstream, kept for existing sessions) are never selected for
   * new sessions: an explicit retired choice and a last-used model that
   * has since retired both fall through to the live fallback. */
  private async resolveDefaultModel(
    provider?: string,
    modelId?: string,
  ): Promise<{ provider: string; modelId: string }> {
    if (provider && modelId) {
      const live = this.models.getModel(provider, modelId);
      if (live === undefined) {
        throw new CoreError(
          `Model not found: ${provider}/${modelId}`,
          "not_found",
        );
      }
      return { provider, modelId };
    }
    const latest = this.sessions.list()[0];
    if (
      latest && this.models.getModel(latest.modelProvider, latest.modelId) &&
      await this.models.hasConfiguredAuth(latest.modelProvider)
    ) {
      return { provider: latest.modelProvider, modelId: latest.modelId };
    }
    const fallback = await this.models.getFallbackModel();
    if (fallback) return fallback;
    throw new CoreError(
      "No models available: no provider is configured",
      "unavailable",
    );
  }

  /** Attach the session's model thinking level so the UI can render the
   * thinking control without an extra fetch, and the chat flag so the UI
   * can render chat sessions (folder-less workspace) distinctly. Retired
   * models (removed upstream, kept for existing sessions) still decorate
   * from their tombstone, so those sessions keep their metadata. */
  private decorateSession(session: SessionInfo): SessionInfo {
    const model = this.models.getSessionModel(
      session.modelProvider,
      session.modelId,
    );
    return {
      ...session,
      ...this.models.thinkingState(
        session.modelProvider,
        session.modelId,
        model,
      ),
      // The model's catalog metadata (context window etc.) rides along so
      // clients can render model-specific UI without a model-list fetch —
      // the session's own model is authoritative even when the catalog
      // changes afterwards.
      model: model !== undefined ? this.models.describeModel(model) : undefined,
      chat: this.getWorkspace(session.workspaceId)?.chat ?? false,
      ...(session.stella === true ? { stella: true } : {}),
    };
  }
}
