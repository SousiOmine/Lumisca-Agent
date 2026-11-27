import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPool } from "./agent/pool.ts";
import type { CredentialStore, Model } from "./ai/catalog.ts";
import { withProviderRetryDefaults } from "./ai/retry-policy.ts";
import type { BrowserBackend } from "./browser/types.ts";
import {
  type CodeStoreRepo,
  createCodeStoreRepo,
} from "./code-execution/store.ts";
import type { ComputerHost } from "./computer/types.ts";
import type { LumiscaDb } from "./db/mod.ts";
import type { ClientEvent } from "./domain/event.ts";
import type { Api } from "./domain/model.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { Workspace } from "./domain/workspace.ts";
import { EventHub } from "./events/hub.ts";
import type { MachineRunner } from "./mcp/machine.ts";
import { McpOAuthStore } from "./mcp/oauth.ts";
import { McpService } from "./mcp/service.ts";
import type { EnvReader } from "./models/custom.ts";
import { ModelManager } from "./models/mod.ts";
import { PushSubscriptions } from "./notify/subscriptions.ts";
import { PersonalizationService } from "./personalization.ts";
import { createRoutineRepo, type RoutineRepo } from "./routine/repo.ts";
import {
  createRoutineScheduler,
  type RoutineRunner,
  type RoutineRunOutcome,
  type RoutineScheduler,
  type RoutineTrigger,
  type WatchCheck,
} from "./routine/scheduler.ts";
import { CommandSafety } from "./safety/command-safety.ts";
import { SavedPromptsService } from "./saved-prompts.ts";
import { ComputerUseService } from "./services/computer.ts";
import { ModelService } from "./services/models.ts";
import { SessionInterruptions } from "./services/session-interruptions.ts";
import { SessionService } from "./services/sessions.ts";
import { StellaAgentService } from "./services/stella-agents.ts";
import { StellaMachineService } from "./services/stella-machines.ts";
import { WorkspaceService } from "./services/workspaces.ts";
import { type AgentRepo, createAgentRepo } from "./session/agents.ts";
import { SessionAttachmentStore } from "./session/attachments.ts";
import { createMessageRepo, type MessageRepo } from "./session/messages.ts";
import { createSessionRepo, type SessionRepo } from "./session/repo.ts";
import {
  createRequestShapeRepo,
  type RequestShapeRepo,
} from "./session/request-shapes.ts";
import { SessionVisualStore } from "./session/visuals.ts";
import { createDbCredentialStore } from "./settings/credentials.ts";
import { appSkillDirs } from "./settings/path.ts";
import type { SettingsRepo } from "./settings/repo.ts";
import { ShareHub } from "./share/hub.ts";
import { ShareRequestRegistry } from "./share/request.ts";
import type { CompactionPolicyInput, Locale, Routine } from "./shared/mod.ts";
import {
  createStellaAgentRepo,
  type StellaAgentRepo,
} from "./stella/agents.ts";
import { AgentIconStore } from "./stella/icons.ts";
import type { VmChannelRunner } from "./vm/channel.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./vm/command.ts";
import { EnvRequestRegistry } from "./vm/env-request.ts";
import { HandoverRegistry } from "./vm/handover-registry.ts";
import { StellaMachine } from "./vm/machine.ts";
import { vmMachineRunner } from "./vm/mcp-runner.ts";
import type { StellaRuntime } from "./vm/runtime.ts";
import {
  createWebSearchSettingsStore,
  type FetchLike,
} from "./websearch/mod.ts";
import { WebSearchService } from "./websearch/service.ts";
import { createWorkspaceRepo } from "./workspace/repo.ts";

/** The areas of the core, as `LumiscaCore.services` exposes them. */
export interface CoreServices {
  readonly sessions: SessionService;
  readonly stellaAgents: StellaAgentService;
  readonly stellaMachines: StellaMachineService;
  readonly models: ModelService;
  readonly webSearch: WebSearchService;
  readonly mcp: McpService;
  readonly workspaces: WorkspaceService;
  readonly personalization: PersonalizationService;
  readonly savedPrompts: SavedPromptsService;
  readonly push: PushSubscriptions;
  /** The dialogs a blocked run waits on: hand-over, env and folder loan. */
  readonly interruptions: SessionInterruptions;
}

/**
 * Everything the service graph needs from the core that owns it. The
 * collaborators are the repositories and stores the core already built; the
 * functions are the few facts only the facade can answer (the language, the
 * chat workspace, the model guards) or that cross more than one service (a
 * session's deletion drops its files, its events and its hand-over hub).
 */
export interface CoreServicesDeps {
  machine: StellaMachine;
  agents: StellaAgentRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
  pool: SessionPool;
  routines: RoutineRepo;
  routineScheduler: RoutineScheduler;
  handovers: HandoverRegistry;
  /** Per-session `vm_env` request hubs; the core's close path forgets
   * them. */
  envRequests: EnvRequestRegistry;
  /** Per-session folder-loan request hubs. */
  shareRequests: ShareRequestRegistry;
  icons: AgentIconStore;
  visuals: SessionVisualStore;
  attachments: SessionAttachmentStore;
  models: ModelManager;
  workspaces: WorkspaceService;
  personalization: PersonalizationService;
  savedPrompts: SavedPromptsService;
  push: PushSubscriptions;
  modelService: ModelService;
  webSearch: WebSearchService;
  mcp: McpService;
  /** For per-agent settings a service must remove with its owner (a
   * deleted agent's MCP config). */
  settings: SettingsRepo;

  decorateSession(session: SessionInfo): SessionInfo;
  emit(event: ClientEvent): void;
  language(): Locale;
  chatWorkspace(): Workspace;
  requireWorkspace(id: string): Workspace;
  resolveDefaultModel(
    provider?: string,
    modelId?: string,
  ): Promise<{ provider: string; modelId: string }>;
  requireModel(provider: string, modelId: string): Model<Api>;
  forget(sessionId: string): void;
  browserAvailable(): boolean;
  computerAvailable(): boolean;
  globalSkillDirs: string[] | undefined;
  appSkillDirs: string[] | undefined;
}

/**
 * Build the core's services, leaves first.
 *
 * `SessionService` needs nothing from the other two, so it is built first; the
 * agent book and the machine side then take the catalog's own `deleteSession`
 * instead of a callback into the facade. The one genuine cycle (creating an
 * agent must also prepare its folder in the machine) is broken with a local
 * reference that is assigned before anything can call it.
 */
export function createCoreServices(deps: CoreServicesDeps): CoreServices {
  const sessions = new SessionService({
    sessions: deps.sessions,
    messages: deps.messages,
    pool: deps.pool,
    visuals: deps.visuals,
    attachments: deps.attachments,
    stella: deps.machine,
    models: {
      getModel: (provider, modelId) => deps.models.getModel(provider, modelId),
      getSessionModel: (provider, modelId) =>
        deps.models.getSessionModel(provider, modelId),
      thinkingState: (provider, modelId, model) =>
        deps.models.thinkingState(provider, modelId, model),
      describeModel: (model) => deps.models.describeModel(model),
      getThinkingLevel: (provider, modelId) =>
        deps.models.getThinkingLevel(provider, modelId),
    },
    requireModel: deps.requireModel,
    agentDisabled: (agentId) => {
      const agent = deps.agents.get(agentId);
      return agent !== undefined && agent.disabledAt !== null;
    },
    requireWorkspace: deps.requireWorkspace,
    chatWorkspace: deps.chatWorkspace,
    resolveDefaultModel: deps.resolveDefaultModel,
    decorate: deps.decorateSession,
    emit: deps.emit,
    forget: deps.forget,
    language: deps.language,
    browserAvailable: deps.browserAvailable,
    computerAvailable: deps.computerAvailable,
    globalSkillDirs: deps.globalSkillDirs,
    appSkillDirs: deps.appSkillDirs,
    stellaSkills: (agentId) => deps.machine.skills(agentId),
  });
  const interruptions = new SessionInterruptions({
    pool: deps.pool,
    handovers: deps.handovers,
    envRequests: deps.envRequests,
    shareRequests: deps.shareRequests,
  });
  const deleteSession = (id: string) => sessions.deleteSession(id);
  // Assigned below, before any call can reach it: creating an agent must
  // prepare its folder in the machine, and the machine needs the agent book.
  let machines: StellaMachineService;
  const stellaAgents = new StellaAgentService({
    agents: deps.agents,
    icons: deps.icons,
    sessions: deps.sessions,
    messages: deps.messages,
    deleteSession,
    language: deps.language,
    emit: deps.emit,
    prepareAgentFolder: (agentId) => machines.prepareAgentFolder(agentId),
    settings: deps.settings,
    removeAgentMachine: (agentId) => machines.removeAgentMachine(agentId),
    stopAgentMachine: (agentId) => machines.stopAgentMachine(agentId),
    modelExists: (provider, modelId) =>
      deps.models.getModel(provider, modelId) !== undefined,
    thinkingLevelsOf: (provider, modelId) =>
      deps.modelService.thinkingLevelsOf(provider, modelId),
    setModelThinkingLevel: (provider, modelId, level) =>
      deps.modelService.setModelThinkingLevel(provider, modelId, level),
    sessionOf: (agentId) => deps.sessions.getByPersona(agentId),
    setSessionModel: (sessionId, provider, modelId) =>
      sessions.setSessionModel(sessionId, provider, modelId),
    resolveDefaultModel: () => deps.resolveDefaultModel(),
    closeSession: (sessionId) => sessions.closeSession(sessionId),
    agentRuntime: (sessionId) => sessions.getAgent(sessionId),
    startOnboarding: (sessionId, instruction) =>
      sessions.startOnboarding(sessionId, instruction),
  });
  // The closures are not called during construction: an agent is created
  // only when a user (or the tool) asks, long after.
  machines = new StellaMachineService({
    machine: deps.machine,
    agents: deps.agents,
    sessions: deps.sessions,
    messages: deps.messages,
    pool: deps.pool,
    routineRepo: deps.routines,
    routineScheduler: deps.routineScheduler,
    watchableTool: (server, tool) =>
      deps.mcp.watchableToolProblem(server, tool),
    handovers: deps.handovers,
    envRequests: deps.envRequests,
    decorateSession: deps.decorateSession,
    createAndAnnounce: (input) => sessions.createAndAnnounce(input),
    deleteSession,
    language: deps.language,
    chatWorkspace: deps.chatWorkspace,
    requireWorkspace: deps.requireWorkspace,
    resolveDefaultModel: deps.resolveDefaultModel,
    createStellaAgent: (input) => stellaAgents.createStellaAgent(input),
  });
  return {
    sessions,
    stellaAgents,
    stellaMachines: machines,
    models: deps.modelService,
    webSearch: deps.webSearch,
    mcp: deps.mcp,
    workspaces: deps.workspaces,
    personalization: deps.personalization,
    savedPrompts: deps.savedPrompts,
    push: deps.push,
    interruptions,
  };
}

/** The mutable parts of a core that its collaborators write after wiring:
 * today only the bytes a prune freed, which the vacuum check reads. */
export interface CoreState {
  freedBytes: number;
}

/** Everything one core owns, built leaves first by createCoreGraph. */
export interface CoreGraph {
  state: CoreState;
  db: LumiscaDb;
  settings: SettingsRepo;
  settingsDir: string | undefined;
  credentials: CredentialStore;
  computer: ComputerUseService;
  models: ModelManager;
  personalization: PersonalizationService;
  savedPrompts: SavedPromptsService;
  push: PushSubscriptions;
  sessions: SessionRepo;
  agents: AgentRepo;
  stellaAgents: StellaAgentRepo;
  routines: RoutineRepo;
  routineScheduler: RoutineScheduler;
  messages: MessageRepo;
  requestShapes: RequestShapeRepo;
  codeStore: CodeStoreRepo;
  commandSafety: CommandSafety;
  webSearch: WebSearchService;
  mcpOAuth: McpOAuthStore;
  visuals: SessionVisualStore;
  attachments: SessionAttachmentStore;
  agentIcons: AgentIconStore;
  dbPath: string | undefined;
  pool: SessionPool;
  mcp: McpService;
  modelService: ModelService;
  workspaces: WorkspaceService;
  services: CoreServices;
  stella: StellaMachine;
  globalSkillDirs: string[] | undefined;
  appSkillDirs: string[];
  events: EventHub;
  handovers: HandoverRegistry;
  envRequests: EnvRequestRegistry;
  shareRequests: ShareRequestRegistry;
  shareHub: ShareHub;
}

/** What the graph builder needs from the facade it is building. The calls
 * happen after the constructor returns, so a closure over the finished core
 * is enough. */
export interface CoreHost {
  buildGeneratedPrompt(
    workspace: Workspace,
    stella?: boolean | { role: string; identity: string; id: string },
  ): string;
  browserBackend(): BrowserBackend | undefined;
  computerHostForSession(): ComputerHost | undefined;
  decorateSession(session: SessionInfo): SessionInfo;
  deleteSession(id: string): Promise<void>;
  emit(event: ClientEvent): void;
  forgetSession(sessionId: string): void;
  getCompactionPolicy(): CompactionPolicyInput;
  getLanguage(): Locale;
  getOrCreateChatWorkspace(): Workspace;
  getStellaKeepFullLog(): boolean;
  isAskToolEnabled(): boolean;
  isCodeExecutionEnabled(): boolean;
  requireModel(provider: string, modelId: string): Model<Api>;
  requireWorkspace(id: string): Workspace;
  resolveDefaultModel(
    provider?: string,
    modelId?: string,
  ): Promise<{ provider: string; modelId: string }>;
  routineRunner(): RoutineRunner;
  setSessionName(id: string, name: string): void;
  stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined;
}

/** The overrides a core accepts: a test replaces any collaborator or seam
 * instead of reaching into the graph after construction. */
export interface CoreOverrides {
  models?: ModelManager;
  personalization?: PersonalizationService;
  savedPrompts?: SavedPromptsService;
  sessions?: SessionRepo;
  agents?: AgentRepo;
  stellaAgents?: StellaAgentRepo;
  routines?: RoutineRepo;
  routineTickMs?: number;
  routineCatchUpDelayMs?: number;
  messages?: MessageRepo;
  requestShapes?: RequestShapeRepo;
  codeStore?: CodeStoreRepo;
  commandSafety?: CommandSafety;
  pool?: SessionPool;
  mcp?: McpService;
  workspaces?: WorkspaceService;
  visuals?: SessionVisualStore;
  attachments?: SessionAttachmentStore;
  agentIcons?: AgentIconStore;
  dbPath?: string;
  globalSkillDirs?: string[];
  appSkillDirs?: string[];
  env?: EnvReader;
  webSearchFetch?: FetchLike;
  stellaRun?: {
    run: VmCommandRunner;
    runBytes: VmCommandBytesRunner;
    openChannel?: VmChannelRunner;
  };
}

/** The scheduler is wired before the facade exists, so its runner resolves
 * the facade only when a tick actually runs. */
class DeferredRoutineRunner implements RoutineRunner {
  constructor(private readonly host: CoreHost) {}
  isRunning(agentId: string): boolean {
    return this.host.routineRunner().isRunning(agentId);
  }
  isAgentEnabled(agentId: string): boolean {
    return this.host.routineRunner().isAgentEnabled(agentId);
  }
  run(
    agentId: string,
    prompt: string,
    routine: { id: string; name: string },
    trigger?: RoutineTrigger,
  ): Promise<RoutineRunOutcome> {
    return this.host.routineRunner().run(agentId, prompt, routine, trigger);
  }
  stop(agentId: string, routineId: string): void {
    this.host.routineRunner().stop(agentId, routineId);
  }
  check(routine: Routine): Promise<WatchCheck> {
    return this.host.routineRunner().check(routine);
  }
}

/**
 * Build one core's collaborators, leaves first.
 *
 * The facade no longer constructs anything: repositories and stores come
 * first, then the services that read them, then the pool that runs sessions.
 * The host is the facade itself, called only after it is constructed;
 * nothing here invokes it during wiring.
 */
export function createCoreGraph(
  db: LumiscaDb,
  settings: SettingsRepo,
  overrides: CoreOverrides,
  host: CoreHost,
): CoreGraph {
  const graph = {} as CoreGraph;
  graph.state = { freedBytes: 0 };
  graph.events = new EventHub();
  graph.handovers = new HandoverRegistry((event) => graph.events.emit(event));
  graph.envRequests = new EnvRequestRegistry((event) =>
    graph.events.emit(event),
  );
  graph.shareRequests = new ShareRequestRegistry((event) =>
    graph.events.emit(event),
  );
  graph.shareHub = new ShareHub();
  graph.globalSkillDirs = overrides.globalSkillDirs;
  const sharedSkillDirs = overrides.appSkillDirs ?? appSkillDirs(overrides.env);
  graph.appSkillDirs = sharedSkillDirs;
  graph.stella = new StellaMachine(
    overrides.globalSkillDirs,
    overrides.stellaRun,
  );
  graph.db = db;
  graph.settings = settings;
  graph.settingsDir = settings.dir();
  graph.credentials = createDbCredentialStore(graph.settings);
  graph.computer = new ComputerUseService({
    getSetting: (key) => graph.settings.get(key),
    setSetting: (key, value) => graph.settings.set(key, value),
    applyCapabilityChange: (mutate) =>
      graph.pool.applyChange(graph.sessions.list(), mutate, "inPlace", {
        inPlace: "tools",
      }),
  });
  graph.models =
    overrides.models ??
    new ModelManager(graph.credentials, graph.settings, overrides.env);
  graph.personalization =
    overrides.personalization ?? new PersonalizationService(graph.settings);
  graph.savedPrompts =
    overrides.savedPrompts ?? new SavedPromptsService(graph.settings);
  graph.push = new PushSubscriptions(graph.settings);
  graph.sessions = overrides.sessions ?? createSessionRepo(db);
  graph.agents = overrides.agents ?? createAgentRepo(db);
  graph.stellaAgents = overrides.stellaAgents ?? createStellaAgentRepo(db);
  graph.routines = overrides.routines ?? createRoutineRepo(db);
  graph.routineScheduler = createRoutineScheduler({
    repo: graph.routines,
    runner: new DeferredRoutineRunner(host),
    ...(overrides.routineTickMs !== undefined
      ? { tickMs: overrides.routineTickMs }
      : {}),
    ...(overrides.routineCatchUpDelayMs !== undefined
      ? { catchUpDelayMs: overrides.routineCatchUpDelayMs }
      : {}),
  });
  graph.messages = overrides.messages ?? createMessageRepo(db);
  graph.requestShapes = overrides.requestShapes ?? createRequestShapeRepo(db);
  graph.codeStore = overrides.codeStore ?? createCodeStoreRepo(db);
  const streamFn = withProviderRetryDefaults(
    graph.models.models.streamFn((providerId) =>
      graph.models.getProviderWithRetired(providerId),
    ),
  );
  graph.commandSafety =
    overrides.commandSafety ??
    new CommandSafety({
      getSetting: (key) => graph.settings.get(key),
      setSetting: (key, value) => graph.settings.set(key, value),
      getFastModel: () => graph.models.getFastModel(),
      streamFn,
    });
  // The web-search configuration lives in the settings file (one JSON
  // entry, see websearch/settings.ts) and the manager turns it into the
  // provider the tools use. Read through the getter on every session open
  // and on every key check, so a change needs no rebuild request.
  graph.webSearch = new WebSearchService({
    settings: createWebSearchSettingsStore(graph.settings),
    locale: () => host.getLanguage(),
    ...(overrides.webSearchFetch === undefined
      ? {}
      : { fetch: overrides.webSearchFetch }),
  });
  // One store of MCP OAuth grants, shared by the sign-in flow (settings)
  // and the session connections (pool), so a sign-in is immediately what
  // the next connection uses.
  graph.mcpOAuth = new McpOAuthStore(graph.settings);
  // Visual assets live beside the database (open() passes that root), so a
  // database and the images its sessions showed travel together. An
  // in-memory core has no such directory: it gets a path under the temp
  // directory, which nothing creates until a session actually publishes
  // (SessionVisualStore.put), so a core that never shows an image leaves
  // nothing behind.
  graph.visuals =
    overrides.visuals ??
    new SessionVisualStore(
      join(tmpdir(), `lumisca-visuals-${crypto.randomUUID()}`),
    );
  // Attachments follow the same rule: beside the database when there is
  // one, a temp directory for an in-memory core, and nothing on disk until
  // a session actually sends a file.
  graph.attachments =
    overrides.attachments ??
    new SessionAttachmentStore(
      join(tmpdir(), `lumisca-attachments-${crypto.randomUUID()}`),
    );
  // Icons follow the two stores above: beside the database when there is
  // one, a temp directory for an in-memory core, and nothing on disk until
  // an agent actually gets a picture.
  graph.agentIcons =
    overrides.agentIcons ??
    new AgentIconStore(
      join(tmpdir(), `lumisca-agent-icons-${crypto.randomUUID()}`),
    );
  graph.dbPath = overrides.dbPath;
  graph.pool =
    overrides.pool ??
    new SessionPool({
      mcpOAuth: graph.mcpOAuth,
      requireModel: (provider, modelId) => host.requireModel(provider, modelId),
      getImageAnalysisModel: () => graph.models.getImageAnalysisModel(),
      getFastModel: () => graph.models.getFastModel(),
      getFastModelInfo: () => graph.models.getFastModelInfo(),
      renameSession: (id, name) => host.setSessionName(id, name),
      getThinkingLevel: (provider, modelId) =>
        graph.models.getThinkingLevel(provider, modelId),
      getLanguage: () => host.getLanguage(),
      getCompactionPolicy: () => host.getCompactionPolicy(),
      getStellaKeepFullLog: () => host.getStellaKeepFullLog(),
      isCodeExecutionEnabled: () => host.isCodeExecutionEnabled(),
      isAskToolEnabled: () => host.isAskToolEnabled(),
      recordFreedBytes: (bytes) => {
        graph.state.freedBytes += bytes;
      },
      buildGeneratedPrompt: (workspace, stella) =>
        host.buildGeneratedPrompt(
          workspace,
          stella === undefined
            ? false
            : { role: stella.role, identity: stella.identity, id: stella.id },
        ),
      personalInstructions: () => {
        const personal = graph.personalization.get();
        return personal.path === "" ? undefined : personal;
      },
      updateSystemPrompt: (id, systemPrompt) =>
        graph.sessions.updateSystemPrompt(id, systemPrompt),
      streamFn,
      messageRepo: graph.messages,
      agents: graph.agents,
      requestShapeRepo: graph.requestShapes,
      codeStore: graph.codeStore,
      commandSafety: graph.commandSafety,
      visuals: graph.visuals,
      attachments: graph.attachments,
      // Resolved lazily (open) so the circular wiring stays one-way:
      // the pool references the service, the service references the pool
      // via the injected applyMcpConfigChange / agentMcpStatus below.
      loadMergedMcp: (workspace) => graph.mcp.loadMergedConfig(workspace),
      // A stella conversation's own MCP servers: they run inside its
      // machine, so the config is per agent and the process has to be
      // started there.
      loadAgentMcp: (agentId) => graph.mcp.loadAgentConfig(agentId),
      machineRunner: (agentId) => mcpMachineRunner(graph.stella, agentId),
      // The agent's own MCP administration (mcp_add / mcp_remove /
      // mcp_list) goes through the same service the settings routes use, so
      // a change made from a conversation is applied exactly like one made
      // in Settings → MCP servers.
      mcpAdmin: (agentId) =>
        agentId === undefined
          ? graph.mcp
          : graph.mcp.agentAdmin(
              agentId,
              mcpMachineRunner(graph.stella, agentId),
            ),
      requireWorkspace: (id) => host.requireWorkspace(id),
      emit: (event) => host.emit(event),
      browser: () => host.browserBackend(),
      computer: () => host.computerHostForSession(),
      webSearch: () => graph.webSearch.provider() ?? undefined,
      stellaRuntime: (session) => host.stellaRuntimeFor(session),
      shares: () => graph.shareHub,
      shareRequests: graph.shareRequests,
      stellaAgentPersona: (session) => {
        const agentId = session.personaId;
        if (agentId === undefined) return undefined;
        const agent = graph.stellaAgents.get(agentId);
        return agent === undefined
          ? undefined
          : { role: agent.role, identity: agent.identity, id: agentId };
      },
      globalSkillDirs: graph.globalSkillDirs,
      appSkillDirs: graph.appSkillDirs,
    });
  graph.mcp =
    overrides.mcp ??
    new McpService({
      settings: graph.settings,
      oauth: graph.mcpOAuth,
      // A stella agent's servers run in its own machine, so the same runner
      // the session uses is what the settings test and the agent's own
      // mcp_add connect through.
      machineRunner: (agentId) => mcpMachineRunner(graph.stella, agentId),
      // Every session, stella's conversation included: a sign-in must
      // reconnect the conversation the user is talking to, and stella has one
      // row that `list()` hides because it is not a session in the UI.
      listSessions: (workspaceId) => graph.sessions.listEvery(workspaceId),
      agentMcpStatus: (sessionId) =>
        graph.pool.get(sessionId)?.getMcpStatus() ?? null,
      requireWorkspace: (id) => host.requireWorkspace(id),
      applyMcpConfigChange: (sessions, mutate) =>
        graph.pool.applyChange(sessions, mutate, "inPlace", { inPlace: "mcp" }),
      refreshSessionMcp: (sessions) =>
        graph.pool.applyChange(sessions, () => {}, "inPlace", {
          inPlace: "mcp-credentials",
        }),
    });
  graph.modelService = new ModelService(
    graph.models,
    (provider, model, level) => {
      for (const session of graph.sessions.list()) {
        if (session.modelProvider === provider && session.modelId === model) {
          graph.pool.setThinkingLevel(session.id, level);
        }
      }
    },
  );
  graph.workspaces =
    overrides.workspaces ??
    new WorkspaceService(createWorkspaceRepo(db), {
      listSessions: (workspaceId) => graph.sessions.list(workspaceId),
      applyChange: (sessions, mutate) =>
        graph.pool.applyChange(sessions, mutate, "reject"),
      // The core's own delete: deleting a workspace drops its sessions'
      // rows AND their visual assets, exactly like deleting a session
      // directly (the pool alone would leave the assets behind).
      deleteSession: (id) => host.deleteSession(id),
    });
  graph.services = createCoreServices({
    settings: graph.settings,
    machine: graph.stella,
    agents: graph.stellaAgents,
    sessions: graph.sessions,
    messages: graph.messages,
    pool: graph.pool,
    routines: graph.routines,
    routineScheduler: graph.routineScheduler,
    handovers: graph.handovers,
    envRequests: graph.envRequests,
    shareRequests: graph.shareRequests,
    icons: graph.agentIcons,
    visuals: graph.visuals,
    attachments: graph.attachments,
    models: graph.models,
    workspaces: graph.workspaces,
    personalization: graph.personalization,
    savedPrompts: graph.savedPrompts,
    push: graph.push,
    modelService: graph.modelService,
    webSearch: graph.webSearch,
    mcp: graph.mcp,
    decorateSession: (session) => host.decorateSession(session),
    emit: (event) => host.emit(event),
    language: () => host.getLanguage(),
    chatWorkspace: () => host.getOrCreateChatWorkspace(),
    requireWorkspace: (id) => host.requireWorkspace(id),
    resolveDefaultModel: (provider, modelId) =>
      host.resolveDefaultModel(provider, modelId),
    requireModel: (provider, modelId) => host.requireModel(provider, modelId),
    forget: (id) => host.forgetSession(id),
    browserAvailable: () => host.browserBackend() !== undefined,
    computerAvailable: () => graph.computer.hostForSession() !== undefined,
    globalSkillDirs: graph.globalSkillDirs,
    appSkillDirs: graph.appSkillDirs,
  });
  // A model change made while a run was in flight is applied once that run
  // has ended: the clients have been told the run is over, and the next run
  // is the first that can use the model. The rebuild is deferred, so its
  // position in the fan-out does not matter.
  graph.events.subscribe((event) => {
    if (event.type === "agent_end") {
      graph.services.sessions.releasePendingRebuild(event.sessionId);
    }
  });
  // A loan change reaches the client as the whole list for the session it
  // belongs to: a lent folder is a security fact the user must always be
  // able to see, and a delta would leave a client that missed one frame
  // showing a folder nobody is serving.
  graph.shareHub.onSharesChange((sessions) => {
    for (const sessionId of sessions) {
      // The announcement is also the answer to a pending request: a folder
      // the user lent from the composer's menu settles the card just as
      // their answer to it would, and a withdrawn one settles a
      // `share_disconnect` even when the desktop app never answered.
      graph.shareRequests
        .get(sessionId)
        ?.settleFromGrants(graph.shareHub.grantsFor(sessionId));
      host.emit({
        type: "shares",
        sessionId,
        shares: graph.shareHub.sharesFor(sessionId),
      });
    }
  });
  return graph;
}

/**
 * How an agent's own MCP servers are started: inside its machine, after the
 * machine is woken and its working folder exists. podman exec does not start
 * a stopped container, and a missing --workdir fails the process.
 */
function mcpMachineRunner(
  stella: StellaMachine,
  agentId: string,
): MachineRunner {
  return vmMachineRunner(agentId, async () => {
    await stella.ensureReady(agentId);
    await stella.ensureAgentFolder(agentId);
  });
}
