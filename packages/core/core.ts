import { LumiscaDb } from "./db/mod.ts";
import { MIN_VACUUM_BYTES, vacuumMarkerPath } from "./db/vacuum.ts";
import { createLogger } from "./log.ts";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ClientEvent } from "./domain/event.ts";
import { EventHub } from "./events/hub.ts";
import type { AgentMessage } from "./ai/types.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { StellaEntry } from "./domain/stella-conversation.ts";
import type { Workspace } from "./domain/workspace.ts";
import {
  createFileSettingsRepo,
  createInMemorySettingsRepo,
  type SettingsRepo,
} from "./settings/repo.ts";
import { appSkillDirs, resolveSettingsPath } from "./settings/path.ts";
import {
  type ConnectionEntry,
  parseConnections,
} from "./settings/connections.ts";
import {
  assertMutableKey,
  assertNotProtected,
  filterExposedSettings,
} from "./settings/guard.ts";
import {
  createWebSearchSettingsStore,
  type FetchLike,
} from "./websearch/mod.ts";
import { WebSearchService } from "./websearch/service.ts";
import { PushSubscriptions } from "./notify/subscriptions.ts";
import type { VapidKeys } from "./notify/vapid.ts";
import type {
  PushSubscriptionKeys,
  PushSubscriptionRecord,
} from "./shared/push.ts";
import type {
  ProviderAuthType,
  WebSearchSettingsView,
  WebSearchTestView,
} from "./shared/mod.ts";
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
import type { ModePrompt } from "./domain/mode-message.ts";
import { ModelManager } from "./models/mod.ts";
import { isThinkingLevel } from "./models/thinking.ts";
import type { EnvReader } from "./models/custom.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./models/user-providers.ts";
import type { ThinkingLevel } from "./shared/mod.ts";
import type { StellaAgentSummary } from "./shared/mod.ts";
import type { CatalogStatus } from "./models/mod.ts";
import type { AskAnswer } from "./shared/mod.ts";
import type { TaskInfo, TodoPhase } from "./shared/mod.ts";
import type { CommandApproval } from "./shared/mod.ts";
import type { CompactionPolicyInput } from "./shared/mod.ts";
import type { BackgroundCommandInfo } from "./tools/background.ts";
import type { PendingQuestion } from "./tools/ask.ts";
import {
  CONNECTIONS_KEY,
  DEFAULT_MODEL_KEY,
  LANGUAGE_KEY,
  type Locale,
  parseCompactionPolicyInput,
  parseModelPreference,
  resolveLocale,
  type SavedPrompt,
} from "./shared/mod.ts";
import { systemLanguageTags } from "./locale.ts";
import { CoreError, errorMessage } from "./errors.ts";
import { createWorkspaceRepo } from "./workspace/repo.ts";
import { WorkspaceService } from "./services/workspaces.ts";
import { type CoreServices, createCoreServices } from "./bootstrap.ts";
import { ComputerUseService } from "./services/computer.ts";
import { ModelService } from "./services/models.ts";
import type { DefaultModel, SessionService } from "./services/sessions.ts";
import { PersonalizationService } from "./personalization.ts";
import { SavedPromptsService } from "./saved-prompts.ts";
import { createSessionRepo, type SessionRepo } from "./session/repo.ts";
import { createMessageRepo, type MessageRepo } from "./session/messages.ts";
import { SessionVisualStore, VISUALS_DIR_NAME } from "./session/visuals.ts";
import {
  ATTACHMENTS_DIR_NAME,
  SessionAttachmentStore,
} from "./session/attachments.ts";
import {
  createRequestShapeRepo,
  type RequestShapeRepo,
} from "./session/request-shapes.ts";
import type { SessionAgent } from "./agent/session-agent.ts";
import { SessionPool } from "./agent/pool.ts";
import { withProviderRetryDefaults } from "./ai/llm-retry.ts";
import {
  buildChatSystemPrompt,
  buildStellaSystemPrompt,
  buildSystemPrompt,
} from "./tools/mod.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./vm/command.ts";
import type { VmManager, VmProgress } from "./vm/container.ts";
import type { StellaAvailability } from "./vm/availability.ts";
import type { StellaStatus } from "./shared/wire.ts";
import { StellaMachine } from "./vm/machine.ts";
import type { StellaRuntime } from "./vm/runtime.ts";
import {
  type AgentRepo,
  createAgentRepo,
  normalizeAgentModel,
  type StellaAgent,
} from "./stella/agents.ts";
import { AGENT_ICONS_DIR_NAME, AgentIconStore } from "./stella/icons.ts";
import { STELLA_ONBOARDING_PROMPT } from "./stella/onboarding.ts";
import type { WindowPage, WindowQuery } from "./session/transcript-window.ts";
import type { ContextUsageSummary } from "./shared/context-usage.ts";
import { createRoutineRepo, type RoutineRepo } from "./routine/repo.ts";
import {
  createRoutineScheduler,
  type RoutineRunner,
  type RoutineScheduler,
  type RoutineTrigger,
} from "./routine/scheduler.ts";
import type { PendingHandover } from "./vm/handover.ts";
import { HandoverRegistry } from "./vm/handover-registry.ts";
import type { PendingEnvRequest } from "./vm/env-request.ts";
import { EnvRequestRegistry } from "./vm/env-request.ts";
import { checkRoutine } from "./routine/check.ts";
import { vmAgentDir } from "./vm/contract.ts";
import type { PromptFileRef, Routine } from "./shared/mod.ts";
import { formatLocalDateTime } from "./shared/mod.ts";
import type { SkillInfo } from "./skills/discover.ts";
import type { UploadFile } from "./vm/uploads.ts";
import type { McpInfo } from "./mcp/config.ts";
import { McpService } from "./mcp/service.ts";
import type { McpTestResult } from "./mcp/service.ts";
import { McpOAuthStore } from "./mcp/oauth.ts";
import type { McpAuthSnapshot } from "./mcp/oauth-session.ts";
import { CommandSafety } from "./safety/command-safety.ts";
import type { BrowserBackend } from "./browser/types.ts";
import type { ComputerHost, ComputerHostResult } from "./computer/types.ts";

/** Module logger (debug-gated). */
const log = createLogger("core");

/** One model as the settings list shows it (see
 * ModelService.listModelsDetailed). */
export interface ModelInfoDetailed {
  id: string;
  name: string;
  contextWindow?: number;
  maxInputTokens?: number;
  reasoning?: boolean;
  input?: string[];
  enabled: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
}

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
  private readonly push: PushSubscriptions;
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
  /** The extracted areas of this facade (see services/). */
  private readonly modelService: ModelService;
  private readonly mcp: McpService;
  /** Where the sessions' published visuals live (the images an agent shows
   * inside its reply — see session/visuals.ts). Shared with the session pool
   * (the visual tool publishes here) and read by the server's asset route. */
  private readonly visuals: SessionVisualStore;
  /** Where the files an agent hands to the user live (see
   * session/attachments.ts). Beside the database like the visuals, shared
   * with the session pool (both `chat_attach` in code mode and `send_chat`
   * in stella write here) and read by the server's attachment route. */
  private readonly attachments: SessionAttachmentStore;
  /** Where the agents' icons live (see stella/icons.ts). Beside the database
   * like the two stores above; written when a user uploads a picture and read
   * by the icon route. */
  private readonly agentIcons: AgentIconStore;
  /** The database file, when this core has one (see requestVacuumIfWorthwhile). */
  private readonly dbPath: string | undefined;
  /** MCP OAuth grants (see mcp/oauth.ts), shared with the session pool. */
  private readonly mcpOAuth: McpOAuthStore;
  private readonly commandSafety: CommandSafety;
  /** The web-search setting and the provider built over it. */
  private readonly webSearch: WebSearchService;
  /** Browser-lab backend (Desktop WebView host), or
   * undefined in plain server mode — the agent then gets no browser
   * tools. Attached by the server (server/mod.ts) before sessions open. */
  private browserBackend: BrowserBackend | undefined;
  /** Computer-use host, its probe and the user's toggle (see
   * services/computer.ts). The server attaches the host before sessions
   * open; whether sessions may actually drive it is the stored setting. */
  private readonly computer: ComputerUseService;
  /** Global skills directory override (see SessionPoolDeps): tests pass an
   * empty list so a fixture's skill catalog never depends on the machine
   * the tests run on. */
  private readonly globalSkillDirs: string[] | undefined;
  /** The mode's shared skills folders (the Lumisca skills folder, see
   * settings/path.ts). Resolved once here so the catalog, the file tools'
   * sandbox and the guide's text name the same folder; empty when this
   * machine has no config home, and for a test (which passes []). */
  private readonly appSkillDirs: string[];
  /** Event fan-out and per-session revision counters (see events/hub.ts). */
  private readonly events = new EventHub();
  /** The virtual machine of stella mode: the manager, its exec seams, the
   * availability verdict and the skill catalog. Attached by the server once
   * it knows where the container files live. */
  private readonly stella: StellaMachine;
  /** Hand-over hubs per session. Dropped with the session. */
  private readonly handovers = new HandoverRegistry((event) =>
    this.events.emit(event)
  );
  /** Environment-variable request hubs per session (`vm_env`). Dropped with
   * the session, like the hand-over hubs. */
  private readonly envRequests = new EnvRequestRegistry((event) =>
    this.events.emit(event)
  );

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
      attachments?: SessionAttachmentStore;
      agentIcons?: AgentIconStore;
      /** The database file, when this core has one: a prune that frees
       * enough bytes marks it for a rewrite at the next start (see
       * db/vacuum.ts). Omitted by an in-memory core. */
      dbPath?: string;
      globalSkillDirs?: string[];
      /** The mode's shared skills folders; default resolved from `env` (the
       * Lumisca skills folder). Tests pass [] so they never read the
       * machine's own folder. */
      appSkillDirs?: string[];
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
    const sharedSkillDirs = overrides.appSkillDirs ??
      appSkillDirs(overrides.env);
    this.appSkillDirs = sharedSkillDirs;
    this.stella = new StellaMachine(
      overrides.globalSkillDirs,
      overrides.stellaRun,
    );
    this.db = db;
    this.settings = settings;
    this.credentials = createDbCredentialStore(this.settings);
    this.computer = new ComputerUseService({
      getSetting: (key) => this.settings.get(key),
      setSetting: (key, value) => this.settings.set(key, value),
      applyCapabilityChange: (mutate) =>
        this.pool.applyCapabilityChange(this.sessions.list(), mutate),
    });
    this.models = overrides.models ??
      new ModelManager(this.credentials, this.settings, overrides.env);
    this.personalization = overrides.personalization ??
      new PersonalizationService(this.settings);
    this.savedPrompts = overrides.savedPrompts ??
      new SavedPromptsService(this.settings);
    this.push = new PushSubscriptions(this.settings);
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
    // Attachments follow the same rule: beside the database when there is
    // one, a temp directory for an in-memory core, and nothing on disk until
    // a session actually sends a file.
    this.attachments = overrides.attachments ??
      new SessionAttachmentStore(
        join(tmpdir(), `lumisca-attachments-${crypto.randomUUID()}`),
      );
    // Icons follow the two stores above: beside the database when there is
    // one, a temp directory for an in-memory core, and nothing on disk until
    // an agent actually gets a picture.
    this.agentIcons = overrides.agentIcons ??
      new AgentIconStore(
        join(tmpdir(), `lumisca-agent-icons-${crypto.randomUUID()}`),
      );
    this.dbPath = overrides.dbPath;
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
      recordFreedBytes: (bytes) => {
        this.freedBytes += bytes;
      },
      buildGeneratedPrompt: (workspace, stella) =>
        this.buildGeneratedPrompt(
          workspace,
          stella === undefined ? false : { role: stella.role, id: stella.id },
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
      commandSafety: this.commandSafety,
      visuals: this.visuals,
      attachments: this.attachments,
      // Resolved lazily (open) so the circular wiring stays one-way:
      // the pool references the service, the service references the pool
      // via the injected applyMcpConfigChange / agentMcpStatus below.
      loadMergedMcp: (workspace) => this.mcp.loadMergedConfig(workspace),
      // The agent's own MCP administration (mcp_add / mcp_remove /
      // mcp_list) goes through the same service the settings routes use, so
      // a change made from a conversation is applied exactly like one made
      // in Settings → MCP servers.
      mcpAdmin: () => this.mcp,
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
          : { role: agent.role, id: agentId };
      },
      globalSkillDirs: this.globalSkillDirs,
      appSkillDirs: this.appSkillDirs,
    });
    this.mcp = overrides.mcp ?? new McpService({
      settings: this.settings,
      oauth: this.mcpOAuth,
      // Every session, stella's conversation included: a sign-in must
      // reconnect the conversation the user is talking to, and stella has one
      // row that `list()` hides because it is not a session in the UI.
      listSessions: (workspaceId) => this.sessions.listEvery(workspaceId),
      agentMcpStatus: (sessionId) =>
        this.pool.get(sessionId)?.getMcpStatus() ?? null,
      requireWorkspace: (id) => this.requireWorkspace(id),
      applyMcpConfigChange: (sessions, mutate) =>
        this.pool.applyMcpConfigChange(sessions, mutate),
      refreshSessionMcp: (sessions) => this.pool.refreshMcp(sessions),
    });
    this.modelService = new ModelService(this.models);
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
    this.services = createCoreServices({
      machine: this.stella,
      agents: this.stellaAgents,
      sessions: this.sessions,
      messages: this.messages,
      pool: this.pool,
      routines: this.routines,
      routineScheduler: this.routineScheduler,
      handovers: this.handovers,
      envRequests: this.envRequests,
      icons: this.agentIcons,
      visuals: this.visuals,
      attachments: this.attachments,
      models: this.models,
      workspaces: this.workspaces,
      modelService: this.modelService,
      webSearch: this.webSearch,
      mcp: this.mcp,
      decorateSession: (session) => this.decorateSession(session),
      emit: (event) => this.emit(event),
      language: () => this.getLanguage(),
      chatWorkspace: () => this.getOrCreateChatWorkspace(),
      requireWorkspace: (id) => this.requireWorkspace(id),
      resolveDefaultModel: (provider, modelId) =>
        this.resolveDefaultModel(provider, modelId),
      requireModel: (provider, modelId) => this.requireModel(provider, modelId),
      forget: (id) => this.forgetSession(id),
      browserAvailable: () => this.browserBackend !== undefined,
      computerAvailable: () => this.computer.hostForSession() !== undefined,
      globalSkillDirs: this.globalSkillDirs,
      appSkillDirs: this.appSkillDirs,
    });
    // A model change made while a run was in flight is applied once that run
    // has ended: the clients have been told the run is over, and the next run
    // is the first that can use the model. The rebuild is deferred, so its
    // position in the fan-out does not matter.
    this.events.subscribe((event) => {
      if (event.type === "agent_end") {
        this.services.sessions.releasePendingRebuild(event.sessionId);
      }
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
        attachments: new SessionAttachmentStore(
          join(dirname(dbPath), ATTACHMENTS_DIR_NAME),
        ),
        agentIcons: new AgentIconStore(
          join(dirname(dbPath), AGENT_ICONS_DIR_NAME),
        ),
        dbPath,
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
        // No shared skills folder either: a test's catalog must come from
        // its own fixture, never from the machine running it.
        appSkillDirs: [],
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
    // The checks' own MCP connections are not any session's (see
    // McpService.checkManager), so nothing else closes them.
    this.mcp.close();
    await this.pool.closeAll();
    // Every session is gone now, so the per-session structures are too. A
    // core is not reopened after close, but releasing them here is what
    // makes the invariant ("nothing outlives its session") checkable. The
    // two maps do not hold the same keys (a hand-over hub exists without
    // ever emitting an event), so the union is what gets forgotten.
    const forgotten = new Set([
      ...this.events.sessionIds(),
      ...this.handovers.sessionIds(),
      ...this.envRequests.sessionIds(),
    ]);
    for (const sessionId of forgotten) this.forgetSession(sessionId);
    // The machine is this application's; leaving it running would keep a
    // container (and a memory-hungry desktop inside it) alive after the app
    // that owns it is gone. A stop that fails is logged by the server's
    // shutdown path, not swallowed here.
    await this.stella.stop();
    this.db.close();
    // Ran out of rows to keep: the file is now mostly free pages, which
    // SQLite reuses but never hands back. The rewrite itself waits for the
    // next start, before any request (see db/vacuum.ts) — a synchronous
    // VACUUM of a multi-gigabyte database would stall every request.
    await this.requestVacuumIfWorthwhile();
  }

  /** Bytes a prune freed in the store since this core started. */
  private freedBytes = 0;

  /** Note that the database file should be rewritten at the next start.
   *
   * A marker rather than a rewrite here: the copy of a large database takes
   * minutes and `node:sqlite` is synchronous, so it only runs before the
   * first request is served. Below the threshold nothing is written — a
   * conversation that only grew a little is not worth a restart's delay. */
  private async requestVacuumIfWorthwhile(): Promise<void> {
    if (this.freedBytes < MIN_VACUUM_BYTES || this.dbPath === undefined) {
      return;
    }
    try {
      await Deno.writeTextFile(
        vacuumMarkerPath(this.dbPath),
        String(this.freedBytes),
        { mode: 0o600 },
      );
    } catch (error) {
      log.warn(
        `could not request a database rewrite: ${errorMessage(error)}`,
      );
    }
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
   * "running now"). Never persisted: it describes this process. A queued run
   * counts as in flight — its prompt is going to run — and `isRoutineQueued`
   * says whether that is what it is doing. */
  isRoutineRunning(id: string): boolean {
    return this.routineScheduler.isRunning(id);
  }

  /** Whether this routine's run is still waiting for its conversation to be
   * free (the settings list draws it apart from "running"). */
  isRoutineQueued(id: string): boolean {
    return this.routineScheduler.isQueued(id);
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
      run: async (agentId, prompt, routine, trigger) => {
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
        // A routine runs in a conversation that is already open, so nothing
        // on this path would otherwise ask whether the machine is up: a
        // machine that died since (a crash, a stop from outside) answered
        // every tool with podman's "container state improper" until the user
        // happened to open the conversation again.
        if (session.stella === true) await this.ensureStellaReady();
        await this.openSession(session.id);
        const agent = this.pool.require(session.id);
        this.sessions.touch(session.id);
        return await agent.runRoutine(withTrigger(prompt, trigger), {
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
      check: async (routine) => {
        const session = this.sessions.getByAgent(routine.agentId);
        if (session === undefined) {
          return {
            kind: "unsupported",
            problem:
              "This agent has no conversation, so its checks have nowhere to run",
          };
        }
        // The machine-bound sources run inside the machine, in the agent's
        // own folder (see routine/check.ts); an MCP check goes through the
        // server's own connection to that server, which is the one the agent
        // calls through, so it works while the machine is down.
        const stella = this.stellaRuntimeFor(session);
        return await checkRoutine(routine, {
          ...(stella === undefined ? {} : {
            machine: {
              runner: stella.runner,
              files: stella.files,
              workdir: stella.cwd,
            },
          }),
          callTool: (server, tool, args, signal) =>
            this.mcp.callToolForCheck(server, tool, args, signal),
        });
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

  // --- computer use (delegated to ComputerUseService) ----------------------

  /** Attach (or detach, with an unavailable result) the computer-use host.
   * The server does this once at startup; the seeded tools resolve the host
   * at execute time, so a later detach fails their next call with a clear
   * error. */
  setComputerHost(result: ComputerHostResult): void {
    this.computer.setHost(result);
  }

  /** Set how to ask this machine again (the server's platform probe). */
  setComputerHostProbe(probe: () => Promise<ComputerHostResult>): void {
    this.computer.setProbe(probe);
  }

  /** Ask this machine again whether it can be driven (see
   * ComputerUseService.recheck). */
  recheckComputerHost(): Promise<ComputerHostResult> {
    return this.computer.recheck();
  }

  /** The attached host, if this machine has one (regardless of the toggle). */
  getComputerHost(): ComputerHost | undefined {
    return this.computer.getHost();
  }

  /** Whether the user enabled computer use (the settings toggle). */
  isComputerUseEnabled(): boolean {
    return this.computer.isEnabled();
  }

  /** Enable or disable computer use; open sessions follow the change. */
  setComputerUseEnabled(enabled: boolean): Promise<void> {
    return this.computer.setEnabled(enabled);
  }

  /** The host a session may drive (attached AND enabled). */
  private computerHostForSession(): ComputerHost | undefined {
    return this.computer.hostForSession();
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: ClientEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  /** Hand an event to every subscriber and count it (see EventHub). */
  private emit(event: ClientEvent): void {
    this.events.emit(event);
  }

  /** See EventHub.getSessionRevision. */
  getSessionRevision(id: string): number {
    return this.events.getSessionRevision(id);
  }

  /** Drop every per-session structure this core keeps outside the pool
   * (the revision counter, the hand-over hub and the env-request hub). The
   * close path, the delete path and the shutdown path all come through here,
   * so a new per-session map has one place to be cleaned up. */
  private forgetSession(sessionId: string): void {
    this.events.forgetSession(sessionId);
    this.handovers.forget(sessionId);
    this.envRequests.get(sessionId)?.cancelAll();
    this.envRequests.forget(sessionId);
  }

  // --- settings -----------------------------------------------------------

  /** Read a setting. Protected keys (credentials, MCP config) are refused —
   * they have their own APIs and must never be readable through the generic
   * settings surface. */
  getSetting(key: string): string | undefined {
    assertNotProtected(key);
    return this.settings.get(key);
  }

  /** Write a setting. Protected keys are refused (they have dedicated
   * APIs). This is the surface the server and the core's own services use,
   * so it accepts every unprotected key — a service writing its own record
   * (the approvals table, the resolved language) must not have to be on a
   * preference allow-list. Client-supplied writes go through
   * {@link setUserSetting} instead. */
  setSetting(key: string, value: string): void {
    assertNotProtected(key);
    this.settings.set(key, value);
  }

  /** Write a preference on behalf of a client (the generic settings route).
   * In addition to the protection check, only the keys declared in
   * settings/guard.ts are accepted: the settings file is shared by many
   * owners, so a key a client invented must not become a permanent dead
   * entry. The protection check runs FIRST, so a credential key is refused
   * as forbidden (403) rather than as an unknown preference (400). */
  setUserSetting(key: string, value: string): void {
    assertNotProtected(key);
    assertMutableKey(key);
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

  // --- Web Push (PWA notifications) ----------------------------------------
  // The store is the settings file (see shared/settings-keys.ts): a
  // subscription belongs to this installation, like the connection registry,
  // and neither is a transcript row that has to survive a rewind.

  /** The stored push subscriptions, oldest first. */
  listPushSubscriptions(): PushSubscriptionRecord[] {
    return this.push.list();
  }

  /** Store one subscription. Re-subscribing the same endpoint replaces its
   * keys instead of adding a second row. */
  addPushSubscription(
    input: { endpoint: string; keys: PushSubscriptionKeys },
  ): PushSubscriptionRecord {
    return this.push.add(input);
  }

  /** Forget one endpoint; false when it was not stored. */
  removePushSubscription(endpoint: string): boolean {
    return this.push.remove(endpoint);
  }

  /** Forget the endpoints a push service reported gone. */
  forgetPushSubscriptions(endpoints: readonly string[]): void {
    this.push.removeEndpoints(endpoints);
  }

  /** The VAPID pair used to sign push messages, created on first use. */
  pushVapidKeys(): Promise<VapidKeys> {
    return this.push.vapidKeys();
  }

  // --- stella agents (delegated to StellaAgentService) -------------------------

  /** The agents in the sidebar, most recently used first. */
  listStellaAgents(): StellaAgent[] {
    return this.services.stellaAgents.listStellaAgents();
  }

  /** The sidebar's rows: the agents, each with what its conversation last
   * said (see StellaAgentService.listStellaAgentSummaries). */
  listStellaAgentSummaries(): StellaAgentSummary[] {
    return this.services.stellaAgents.listStellaAgentSummaries();
  }

  /**
   * The agent a fresh installation talks to, created on the first read.
   *
   * Asynchronous because creating one also prepares its working folder and
   * MEMORY.md (see prepareStellaAgentFolder); an agent that already exists
   * answers without touching the machine.
   */
  async ensureStellaAgent(): Promise<StellaAgent> {
    const before = this.services.stellaAgents.listStellaAgents().length;
    const agent = this.services.stellaAgents.ensureStellaAgent();
    if (before === 0) await this.prepareStellaAgentFolder(agent.id);
    return agent;
  }

  getStellaAgent(id: string): StellaAgent | undefined {
    return this.services.stellaAgents.getStellaAgent(id);
  }

  /**
   * Create an agent, and prepare its working folder in the machine.
   *
   * Asynchronous for that second half only: the row is a database write, but
   * the folder and MEMORY.md are files inside the machine, and the file the
   * system prompt names should exist before the agent's first turn. The row is
   * written first because the folder is named after the agent's id; the folder
   * is skipped when the machine is not running, and the first conversation
   * prepares it then (see StellaMachineService.prepareAgentFolder).
   */
  async createStellaAgent(
    input: { name: string; role: string },
  ): Promise<StellaAgent> {
    const agent = this.services.stellaAgents.createStellaAgent(input);
    await this.prepareStellaAgentFolder(agent.id);
    return agent;
  }

  /** One agent's folder and memory file in the machine, when the machine is
   * up. Both creation paths above go through this, so neither can forget. */
  private prepareStellaAgentFolder(agentId: string): Promise<void> {
    return this.services.stellaMachines.prepareAgentFolder(agentId);
  }

  /**
   * Change an agent's name, picture, model and/or its model's thinking
   * strength.
   *
   * Everything is validated here rather than in the agent book, and before a
   * single byte is written: the book cannot see the catalog, and a save that
   * stored the name and refused the model would leave the dialog explaining
   * which half happened.
   *
   * The thinking strength belongs to a MODEL, not to the agent (it applies to
   * every conversation on that model), so the patch names the model it is
   * for: the dialog drew the list of levels from that model, and resolving
   * "the agent's model" again here could store the level on a model the user
   * was not looking at.
   *
   * A conversation with a run in flight is not an error: the choice is stored
   * and applied when that run ends (SessionService.setSessionModel). The
   * dialog can be used at any time, and the answer to "show me this from the
   * next run" is the same as for an idle conversation.
   *
   * Afterwards the conversation row follows the choice (see
   * applyStellaAgentModel). An agent whose conversation does not exist yet
   * simply opens on it later (see StellaMachineService.getOrCreateStellaSession).
   */
  async updateStellaAgent(
    id: string,
    patch: {
      name?: string;
      icon?: { bytes: Uint8Array; extension: string } | null;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: { provider: string; modelId: string; level: string };
    },
  ): Promise<StellaAgent> {
    const agent = this.stellaAgents.get(id);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    const model = patch.model === undefined
      ? undefined
      : normalizeAgentModel(patch.model);
    if (
      model !== undefined && model !== null &&
      this.models.getModel(model.provider, model.modelId) === undefined
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
      // Refused rather than clamped: the dialog draws this list from the same
      // model, so a level it does not offer means the two disagree about
      // which model was being edited — and storing a neighbouring level would
      // hide that.
      const offered = this.modelService.thinkingLevelsOf(
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
    const updated = await this.services.stellaAgents.updateStellaAgent(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      icon: patch.icon,
      ...(model === undefined ? {} : { model }),
    });
    if (model !== undefined) await this.applyStellaAgentModel(id, model);
    // Through the same setter the model settings use, so open conversations
    // on that model pick the level up for their next run.
    if (thinking !== undefined) {
      this.setModelThinkingLevel(
        thinking.provider,
        thinking.modelId,
        thinking.level,
      );
    }
    return updated;
  }

  /**
   * Point an agent's conversation at `model` (null = the app's default).
   *
   * The conversation's row is what a run reads, so the choice is written
   * there as well as on the agent — immediately, and for an idle agent the
   * rebuild happens now. A run in flight keeps its model and the change lands
   * as the run ends (see SessionService.setSessionModel). An agent without a
   * conversation has nothing to point: its row is created from the agent's
   * choice when the conversation is first opened.
   */
  private async applyStellaAgentModel(
    agentId: string,
    model: { provider: string; modelId: string } | null,
  ): Promise<void> {
    const session = this.sessions.getByAgent(agentId);
    if (session === undefined) return;
    let wanted = model;
    if (wanted === null) {
      try {
        wanted = await this.resolveDefaultModel(undefined, undefined);
      } catch {
        // Nothing is configured to run on, so there is no default to move to.
        // The conversation keeps the model it has; the agent's own field
        // already says "default", which is what applies once one exists.
        return;
      }
    }
    if (
      session.modelProvider === wanted.provider &&
      session.modelId === wanted.modelId
    ) {
      return;
    }
    this.services.sessions.setSessionModel(
      session.id,
      wanted.provider,
      wanted.modelId,
    );
  }

  resolveStellaAgentIcon(
    id: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.services.stellaAgents.resolveStellaAgentIcon(id, name);
  }

  deleteStellaAgent(id: string): Promise<void> {
    return this.services.stellaAgents.deleteStellaAgent(id);
  }

  // --- the stella machine (delegated to StellaMachineService) --------------------

  /** Attach the stella machine (the server does this at start-up, once it
   * has resolved where the container files live). Detach with undefined. */
  setStellaVm(vm: VmManager | undefined): void {
    this.services.stellaMachines.setStellaVm(vm);
  }

  /** The machine, when one is attached. */
  getStellaVm(): VmManager | undefined {
    return this.services.stellaMachines.getStellaVm();
  }

  /** Whether stella mode can run here, with the reason when it cannot. */
  getStellaAvailability(): Promise<StellaAvailability> {
    return this.services.stellaMachines.getStellaAvailability();
  }

  getOrCreateStellaSession(agentId?: string): Promise<SessionInfo> {
    return this.services.stellaMachines.getOrCreateStellaSession(agentId);
  }

  /**
   * Start a new agent's setup turn, once.
   *
   * Opening its conversation is the first moment the machine is up, the
   * session exists, and the app can speak before the user does. The turn
   * itself is a prompt only the model reads (SessionAgent.startOnboarding):
   * the conversation shows the agent's greeting and questions, never the
   * instruction to ask them.
   *
   * Returns whether this call started it. False also covers "a run is
   * already going" — the claim is left NULL there, so the next open tries
   * again instead of steering setup text into someone's work.
   */
  startStellaOnboarding(agentId: string): boolean {
    const agent = this.services.stellaAgents.getStellaAgent(agentId);
    if (agent === undefined || agent.onboardedAt !== null) return false;
    const session = this.sessions.getByAgent(agentId);
    if (session === undefined) return false;
    const open = this.services.sessions.getAgent(session.id);
    if (open === undefined || open.isStreaming) return false;
    // Claimed before the prompt is delivered: two clients opening the same
    // conversation at once must start one turn, not two.
    if (!this.services.stellaAgents.markOnboarded(agentId)) return false;
    try {
      this.services.sessions.startOnboarding(
        session.id,
        STELLA_ONBOARDING_PROMPT,
      );
    } catch (error) {
      // The turn did not start, so it has not happened: give the claim back
      // rather than leave the agent looking set up forever.
      this.services.stellaAgents.clearOnboarded(agentId);
      log.warn(`stella setup turn did not start: ${errorMessage(error)}`);
      return false;
    }
    return true;
  }

  /** Run an agent's setup turn again (the sidebar's "設定をやり直す"). The
   * claim is cleared only when the turn can actually start, so a click
   * during a run changes nothing and the next open is not surprised. */
  restartStellaOnboarding(agentId: string): boolean {
    const session = this.sessions.getByAgent(agentId);
    if (session === undefined) return false;
    const open = this.services.sessions.getAgent(session.id);
    if (open === undefined || open.isStreaming) return false;
    this.services.stellaAgents.clearOnboarded(agentId);
    return this.startStellaOnboarding(agentId);
  }

  ensureStellaReady(
    onProgress?: (progress: VmProgress) => void,
  ): Promise<void> {
    return this.services.stellaMachines.ensureStellaReady(onProgress);
  }

  isStellaStarting(): boolean {
    return this.services.stellaMachines.isStellaStarting();
  }

  getStellaStatus(): Promise<StellaStatus> {
    return this.services.stellaMachines.getStellaStatus();
  }

  /** Re-read one stella agent's skill catalog (its own folder plus the
   * machine's shared one). */
  refreshStellaSkills(agentId: string): Promise<void> {
    return this.services.stellaMachines.refreshStellaSkills(agentId);
  }

  /** The runtime a stella session's tools run on (see StellaMachineService). */
  private stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined {
    return this.services.stellaMachines.stellaRuntimeFor(session);
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

  /** The environment variable a session's run is waiting for (the resync
   * snapshot carries it so a client that reconnects while the run is blocked
   * can still answer the dialog). */
  getPendingEnvRequest(sessionId: string): PendingEnvRequest | null {
    return this.pool.get(sessionId)?.getPendingEnvRequest() ?? null;
  }

  /** The user entered a value for the environment variable the run is
   * waiting on: store it in the machine and let the run continue.
   *
   * The value goes from here into the machine and nowhere else — it is not
   * logged, not recorded on the session, and not part of what the tool
   * returns. */
  provideStellaEnv(
    sessionId: string,
    value: unknown,
    toolCallId?: string,
  ): Promise<void> {
    return this.services.stellaMachines.provideEnv(
      sessionId,
      value,
      toolCallId,
    );
  }

  /** The user refused to enter a value (or closed the dialog): the run
   * continues without it. */
  declineStellaEnv(sessionId: string, toolCallId?: string): void {
    this.services.stellaMachines.declineEnv(sessionId, toolCallId);
  }

  /** The text on the stella machine's clipboard (empty when nothing was
   * copied there). The chat's screen pane reads it while the user drives the
   * screen: the VNC connection cannot carry it, which is why it goes through
   * the server (see vm/clipboard.ts). */
  readStellaClipboard(sessionId: string): Promise<string> {
    return this.services.stellaMachines.readClipboard(
      this.requireSession(sessionId),
    );
  }

  /** Put text on the stella machine's clipboard, for the application the user
   * is about to paste into. */
  async writeStellaClipboard(sessionId: string, text: string): Promise<void> {
    await this.services.stellaMachines.writeClipboard(
      this.requireSession(sessionId),
      text,
    );
  }

  /** One session row, or the same "not found" every id-addressed call
   * answers. */
  private requireSession(sessionId: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${sessionId}`, "not_found");
    }
    return session;
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
  // --- workspaces (delegated to WorkspaceService) -------------------------

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

  // --- MCP configuration ----------------------------------------------------

  // --- sessions (delegated to SessionService) ------------------------------

  /** The model a new session would get, with its thinking control data. */
  getDefaultModel(): Promise<DefaultModel | null> {
    return this.services.sessions.getDefaultModel();
  }

  createSession(input: CreateSessionInput): Promise<SessionInfo> {
    return this.services.sessions.createSession(input);
  }

  listSessions(workspaceId?: string): SessionInfo[] {
    return this.services.sessions.listSessions(workspaceId);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.services.sessions.getSession(id);
  }

  /** The thinking level a session's model runs at, and the levels that model
   * supports. The level belongs to the model (the settings store keys it by
   * provider and model), not to the session, so it is read through the
   * session's current model every time: switching models in the picker
   * changes both halves. */
  getThinkingState(
    sessionId: string,
  ): { thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[] } {
    const session = this.getSession(sessionId);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${sessionId}`, "not_found");
    }
    const model = this.models.getSessionModel(
      session.modelProvider,
      session.modelId,
    );
    return this.models.thinkingState(
      session.modelProvider,
      session.modelId,
      model,
    );
  }

  /** The file one of a session's published visuals names. */
  resolveSessionVisual(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.services.sessions.resolveSessionVisual(sessionId, name);
  }

  /** The file one of a session's attachments names. */
  resolveSessionAttachment(
    sessionId: string,
    name: string,
  ): ReturnType<SessionService["resolveSessionAttachment"]> {
    return this.services.sessions.resolveSessionAttachment(sessionId, name);
  }

  openSession(id: string): SessionInfo {
    return this.services.sessions.openSession(id);
  }

  closeSession(id: string): Promise<void> {
    return this.services.sessions.closeSession(id);
  }

  deleteSession(id: string): Promise<void> {
    return this.services.sessions.deleteSession(id);
  }

  getAgent(id: string): SessionAgent | undefined {
    return this.services.sessions.getAgent(id);
  }

  getTodo(id: string): TodoPhase[] {
    return this.services.sessions.getTodo(id);
  }

  getTasks(id: string): TaskInfo[] {
    return this.services.sessions.getTasks(id);
  }

  getBackground(id: string): BackgroundCommandInfo[] {
    return this.services.sessions.getBackground(id);
  }

  getPendingQuestions(id: string): PendingQuestion[] {
    return this.services.sessions.getPendingQuestions(id);
  }

  /** The skills a session in this workspace would get. */
  listSkills(workspaceId?: string): SkillInfo[] {
    return this.services.sessions.listSkills(workspaceId);
  }

  /** The stella conversation's skill catalog. Per conversation: a stella
   * agent's own skills live in its folder inside the machine, so two agents
   * do not share a catalog (only the machine-wide folder is common). */
  listStellaSkills(agentId: string): SkillInfo[] {
    return this.services.sessions.listStellaSkills(agentId);
  }

  getSessionLastError(id: string): string | undefined {
    return this.services.sessions.getSessionLastError(id);
  }

  /** One window of a session's transcript, for the clients that draw it. */
  readTranscript(
    id: string,
    query: WindowQuery,
  ): WindowPage<AgentMessage> | undefined {
    return this.services.sessions.readTranscript(id, query);
  }

  /** The session's context usage over the WHOLE transcript. */
  getSessionUsage(id: string): ContextUsageSummary {
    return this.services.sessions.getSessionUsage(id);
  }

  /** The conversation a stella agent already has, if any. */
  findStellaSession(agentId: string): SessionInfo | undefined {
    return this.services.sessions.findStellaSession(agentId);
  }

  /** One window of a stella conversation, in the shape its client draws. */
  readStellaConversation(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> | undefined {
    return this.services.sessions.readStellaConversation(id, query);
  }

  /** Put a prompt's attached files into the machine. */
  savePromptUploads(
    id: string,
    uploads: readonly UploadFile[],
  ): Promise<PromptFileRef[]> {
    return this.services.sessions.savePromptUploads(id, uploads);
  }

  /** Read one file a prompt brought back out of the machine. */
  resolvePromptUpload(
    agentId: string,
    ref: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    return this.services.sessions.resolvePromptUpload(agentId, ref);
  }

  /** Send a prompt into a session (fire-and-forget). */
  startPrompt(
    id: string,
    text: string,
    images?: ImageContent[],
    mode?: ModePrompt,
    files?: PromptFileRef[],
  ): void {
    this.services.sessions.startPrompt(id, text, images, mode, files);
  }

  abort(id: string): void {
    this.services.sessions.abort(id);
  }

  answerQuestion(id: string, toolCallId: string, answers: AskAnswer[]): void {
    this.services.sessions.answerQuestion(id, toolCallId, answers);
  }

  rewind(id: string, timestamp: number): Promise<void> {
    return this.services.sessions.rewind(id, timestamp);
  }

  compactSession(
    id: string,
    instructions?: string,
  ): Promise<number | undefined> {
    return this.services.sessions.compactSession(id, instructions);
  }

  setSessionModel(id: string, provider: string, modelId: string): void {
    this.services.sessions.setSessionModel(id, provider, modelId);
  }

  setSessionName(id: string, name: string): void {
    this.services.sessions.setSessionName(id, name);
  }

  getModelThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
    return this.services.sessions.getModelThinkingLevel(providerId, modelId);
  }

  /** Set the thinking level of a model (persisted, per model). Open
   * sessions using the model pick the change up in place from their next
   * run onward. */
  setModelThinkingLevel(
    providerId: string,
    modelId: string,
    level: string,
  ): ThinkingLevel {
    const effective = this.modelService.setModelThinkingLevel(
      providerId,
      modelId,
      level,
    );
    // The level is the model's, but a session already running on it must
    // apply it to the run in progress (see SessionPool.setThinkingLevel).
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

  // --- user-defined OpenAI-compatible providers ----------------------------

  // --- model catalog (models.dev live sync) -------------------------------

  /**
   * The areas this facade is made of, each a class over its own
   * collaborators. A route can be handed the one it needs (see the
   * `XxxApi` interfaces in packages/server/routes), and a caller that wants
   * to know what the app can do reads this list instead of scrolling a
   * two-thousand-line class.
   *
   * The delegating methods below stay so an existing caller keeps working;
   * new code should reach through here.
   */
  readonly services: CoreServices;

  // --- the extracted areas ------------------------------------------------
  //
  // One line per area: the implementation lives in services/, and these
  // methods keep the signatures callers already use. A new area should not
  // add another block of them — reach it through `services` instead.

  // workspaces
  async createWorkspace(name: string, folders: string[]): Promise<Workspace> {
    return await this.workspaces.create(name, folders);
  }

  listWorkspaces(): Workspace[] {
    return this.workspaces.list();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  async updateWorkspace(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace> {
    return await this.workspaces.update(id, input);
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.workspaces.delete(id);
  }

  // web search
  getWebSearchSettings(): WebSearchSettingsView {
    return this.webSearch.view();
  }

  addWebSearchProvider(
    input: { id: string; apiKey: string },
  ): WebSearchSettingsView {
    return this.webSearch.add(input);
  }

  updateWebSearchProvider(
    id: string,
    input: { apiKey: string },
  ): WebSearchSettingsView {
    return this.webSearch.update(id, input);
  }

  removeWebSearchProvider(id: string): WebSearchSettingsView {
    return this.webSearch.remove(id);
  }

  setDefaultWebSearchProvider(id: string | null): WebSearchSettingsView {
    return this.webSearch.setDefault(id);
  }

  testWebSearchProvider(input: {
    id: string;
    apiKey: string | null;
  }): Promise<WebSearchTestView> {
    return this.webSearch.test(input);
  }

  // MCP configuration
  getAppMcpInfo(): McpInfo {
    return this.mcp.getAppMcpInfo();
  }

  setAppMcpConfig(text: string): McpInfo {
    return this.mcp.setAppMcpConfig(text);
  }

  getMcpInfo(workspaceId: string): McpInfo {
    return this.mcp.getMcpInfo(workspaceId);
  }

  setMcpConfig(workspaceId: string, text: string): McpInfo {
    return this.mcp.setMcpConfig(workspaceId, text);
  }

  testMcpServer(text: string): Promise<McpTestResult> {
    return this.mcp.testServer(text);
  }

  startMcpAuth(text: string, redirectUri: string): Promise<McpAuthSnapshot> {
    return this.mcp.startAuth(text, redirectUri);
  }

  getMcpAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.mcp.getAuth(sessionId);
  }

  cancelMcpAuth(sessionId: string): boolean {
    return this.mcp.cancelAuth(sessionId);
  }

  completeMcpAuth(
    input: { state: string; code?: string; error?: string },
  ): Promise<McpAuthSnapshot | undefined> {
    return this.mcp.completeAuth(input);
  }

  // models
  listProviders(): readonly Provider[] {
    return this.services.models.listProviders();
  }

  listModels(providerId?: string): readonly Model<Api>[] {
    return this.services.models.listModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.services.models.getModel(providerId, modelId);
  }

  checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return this.services.models.checkAuth(providerId);
  }

  getProviderAuthType(providerId: string): ProviderAuthType | undefined {
    return this.services.models.getProviderAuthType(providerId);
  }

  hasProviderAuth(providerId: string): Promise<boolean> {
    return this.services.models.hasProviderAuth(providerId);
  }

  hasConfiguredAuth(providerId: string): Promise<boolean> {
    return this.services.models.hasConfiguredAuth(providerId);
  }

  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    this.services.models.setModelEnabled(providerId, modelId, enabled);
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.services.models.isModelEnabled(providerId, modelId);
  }

  listModelsDetailed(providerId: string): ModelInfoDetailed[] {
    return this.services.models.listModelsDetailed(providerId);
  }

  listUserProviders(): Promise<UserProviderSummary[]> {
    return this.services.models.listUserProviders();
  }

  getUserProvider(id: string): UserProviderConfig | undefined {
    return this.services.models.getUserProvider(id);
  }

  addUserProvider(input: UserProviderInput): Promise<UserProviderSummary> {
    return this.services.models.addUserProvider(input);
  }

  updateUserProvider(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    return this.services.models.updateUserProvider(id, input);
  }

  removeUserProvider(id: string): Promise<void> {
    return this.services.models.removeUserProvider(id);
  }

  isUserProvider(id: string): boolean {
    return this.services.models.isUserProvider(id);
  }

  getModelCatalogStatus(): CatalogStatus {
    return this.services.models.getModelCatalogStatus();
  }

  refreshModelCatalog(
    options: {
      fetch?: typeof globalThis.fetch;
      timeoutMs?: number;
      baseUrl?: string;
    } = {},
  ): Promise<CatalogStatus> {
    return this.services.models.refreshModelCatalog(options);
  }

  // --- internals ----------------------------------------------------------

  private requireWorkspace(id: string): Workspace {
    return this.workspaces.require(id);
  }

  /** The generated system prompt for a workspace: who the agent is and the
   * folders it may touch. Chat workspaces (folder-less, "simple chat") get
   * the chat variant instead — no workspace framing, matching their tool
   * set. Workspace instructions (AGENTS.md) and the machine-level personal
   * instructions are NOT part of this string: they are published as dynamic
   * context messages (see ai/context-providers), so an edit reaches a
   * session that is already open.
   *
   * Everything that varies while a session lives is outside this function
   * for the same reason: a session open can re-derive the prompt and
   * compare it against the stored one only if unchanged inputs give an
   * identical string. */
  private buildGeneratedPrompt(
    workspace: Workspace,
    stella: boolean | { role: string; id: string } = false,
  ): string {
    // Neither the language nor the model is read here: both are published as
    // context messages (agent/language-context.ts, agent/model-context.ts),
    // because both can change while the session lives. That is also what
    // keeps this string stable across opens — which is what lets
    // ensureSystemPrompt compare it against the stored value.
    // stella's conversation row shares the folder-less chat workspace, but
    // its prompt is the machine's: a chat prompt would tell it it cannot
    // run anything, which is the opposite of what it can do.
    if (stella !== false) {
      return buildStellaSystemPrompt(
        stella === true ? {} : {
          agent: { role: stella.role },
          workdir: vmAgentDir(stella.id),
        },
      );
    }
    return workspace.chat
      ? buildChatSystemPrompt()
      : buildSystemPrompt(workspace);
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
    // The user's own default first: a new conversation starts on the model
    // they chose, not on whatever was used last. A default that names a model
    // this installation cannot reach (a provider removed since, a retired
    // id) is skipped rather than obeyed — it would otherwise make every new
    // session fail on a setting the user cannot see from here.
    const preferred = parseModelPreference(
      this.settings.get(DEFAULT_MODEL_KEY),
    );
    if (
      preferred !== undefined &&
      this.models.getModel(preferred.provider, preferred.modelId) !==
        undefined &&
      await this.models.hasConfiguredAuth(preferred.provider)
    ) {
      return { provider: preferred.provider, modelId: preferred.modelId };
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

/** The routine's prompt as the run receives it, with one line naming the
 * check that fired it.
 *
 * Routine prompts are not drawn in the transcript (see stella-state.ts), so
 * the line changes nothing the user sees. It saves the run an MCP call whose
 * only purpose would be learning how much happened, and it keeps an item
 * from being missed when the user read the same list between the check and
 * the run.
 *
 * A scheduled run gets the prompt alone: nothing fired it but the clock. */
function withTrigger(prompt: string, trigger?: RoutineTrigger): string {
  if (trigger === undefined) return prompt;
  return `${trigger.newItems} new item(s) appeared at ${
    formatLocalDateTime(trigger.at)
  }, and the routine's watch check started this run with that observation.\n\n` +
    prompt;
}
