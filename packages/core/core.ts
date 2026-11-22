import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionPool } from "./agent/pool.ts";
import type { SessionAgent } from "./agent/session-agent.ts";
import type {
  AuthCheck,
  AuthInteraction,
  AuthType,
  CredentialStore,
  Model,
  Provider,
} from "./ai/catalog.ts";
import {
  type CoreGraph,
  type CoreHost,
  type CoreOverrides,
  type CoreServices,
  type CoreState,
  createCoreGraph,
} from "./bootstrap.ts";
import type { BrowserBackend } from "./browser/types.ts";
import type { CodeStoreRepo } from "./code-execution/store.ts";
import type { ComputerHost, ComputerHostResult } from "./computer/types.ts";
import { LumiscaDb } from "./db/mod.ts";
import { MIN_VACUUM_BYTES, vacuumMarkerPath } from "./db/vacuum.ts";
import type { ClientEvent } from "./domain/event.ts";
import type { AgentMessage, ImageContent } from "./domain/message.ts";
import type { ModePrompt } from "./domain/mode-message.ts";
import type { Api } from "./domain/model.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { FolderShare } from "./domain/share.ts";
import type { StellaEntry } from "./domain/stella-conversation.ts";
import type { Workspace } from "./domain/workspace.ts";
import { CoreError, errorMessage } from "./errors.ts";
import type { EventHub } from "./events/hub.ts";
import { createLogger } from "./log.ts";
import type { McpInfo } from "./mcp/config.ts";
import type { McpOAuthStore } from "./mcp/oauth.ts";
import type { McpAuthSnapshot } from "./mcp/oauth-session.ts";
import type { McpService, McpTestResult } from "./mcp/service.ts";
import type { EnvReader } from "./models/custom.ts";
import type { CatalogStatus, ModelManager } from "./models/mod.ts";
import { isThinkingLevel } from "./models/thinking.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./models/user-providers.ts";
import type { PushSubscriptions } from "./notify/subscriptions.ts";
import type { VapidKeys } from "./notify/vapid.ts";
import type { PersonalizationService } from "./personalization.ts";
import type { SavedPromptsService } from "./saved-prompts.ts";
import type { ComputerUseService } from "./services/computer.ts";
import type { ModelService } from "./services/models.ts";
import { RoutineService } from "./services/routines.ts";
import type { DefaultModel, SessionService } from "./services/sessions.ts";
import { SettingsService } from "./services/settings.ts";
import type { WorkspaceService } from "./services/workspaces.ts";
import type { AgentRepo } from "./session/agents.ts";
import {
  ATTACHMENTS_DIR_NAME,
  SessionAttachmentStore,
} from "./session/attachments.ts";
import type { MessageRepo } from "./session/messages.ts";
import type { SessionRepo } from "./session/repo.ts";
import type { RequestShapeRepo } from "./session/request-shapes.ts";
import type { WindowPage, WindowQuery } from "./session/transcript-window.ts";
import { SessionVisualStore, VISUALS_DIR_NAME } from "./session/visuals.ts";
import { setApiKey } from "./settings/credentials.ts";
import { resolveSettingsPath } from "./settings/path.ts";
import {
  createFileSettingsRepo,
  createInMemorySettingsRepo,
  type SettingsRepo,
} from "./settings/repo.ts";
import type { ShareHub } from "./share/hub.ts";
import type {
  PendingShareRequest,
  ShareRequestRegistry,
} from "./share/request.ts";
import type { ContextUsageSummary } from "./shared/context-usage.ts";
import type {
  AskAnswer,
  PromptFileRef,
  ProviderAuthType,
  StellaAgentSummary,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
  WebSearchSettingsView,
  WebSearchTestView,
} from "./shared/mod.ts";
import {
  APP_UI_IN_SYSTEM_PROMPT_KEY,
  ASK_TOOL_ENABLED_KEY,
  appUiInSystemPrompt,
  askToolEnabled,
  CODE_EXECUTION_ENABLED_KEY,
  codeExecutionEnabled,
  DEFAULT_MODEL_KEY,
  parseModelPreference,
  type SavedPrompt,
} from "./shared/mod.ts";
import type {
  PushSubscriptionKeys,
  PushSubscriptionRecord,
} from "./shared/push.ts";
import type { StellaMachineStatus, StellaStatus } from "./shared/wire.ts";
import type { SkillInfo } from "./skills/discover.ts";
import {
  normalizeAgentModel,
  type StellaAgent,
  type StellaAgentRepo,
} from "./stella/agents.ts";
import { AGENT_ICONS_DIR_NAME, AgentIconStore } from "./stella/icons.ts";
import { STELLA_ONBOARDING_PROMPT } from "./stella/onboarding.ts";
import type { PendingQuestion } from "./tools/ask.ts";
import type { BackgroundCommandInfo } from "./tools/background.ts";
import {
  buildChatSystemPrompt,
  buildStellaSystemPrompt,
  buildSystemPrompt,
} from "./tools/mod.ts";
import type { StellaAvailability } from "./vm/availability.ts";
import type { VmChannelRunner } from "./vm/channel.ts";
import type { VmCommandBytesRunner, VmCommandRunner } from "./vm/command.ts";
import type { VmHost } from "./vm/container.ts";
import { vmAgentDir } from "./vm/contract.ts";
import type {
  EnvRequestRegistry,
  PendingEnvRequest,
} from "./vm/env-request.ts";
import type { PendingHandover } from "./vm/handover.ts";
import type { HandoverRegistry } from "./vm/handover-registry.ts";
import type { StellaMachine } from "./vm/machine.ts";
import type { StellaRuntime } from "./vm/runtime.ts";
import type { HostPromptFile, PromptImageFile } from "./vm/uploads.ts";
import type { WebSearchService } from "./websearch/service.ts";

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

  private readonly credentials: CredentialStore;
  private readonly workspaces: WorkspaceService;
  private readonly personalization: PersonalizationService;
  private readonly savedPrompts: SavedPromptsService;
  private readonly push: PushSubscriptions;
  private readonly sessions: SessionRepo;
  /** The sessions' agents: each session's main row and its sub-agents (see
   * session/agents.ts). */
  private readonly agents: AgentRepo;
  private readonly stellaAgents: StellaAgentRepo;
  /** The installation's settings, setup marker and approvals (see
   * SettingsService). */
  readonly settings: SettingsService;
  /** The scheduled requests of stella conversations (see RoutineService).
   * The scheduler is created in the graph so tests can drive it with a short
   * tick; the server starts and stops it (see server/mod.ts). */
  readonly routines: RoutineService;
  private readonly messages: MessageRepo;
  private readonly requestShapes: RequestShapeRepo;
  /** The scripting tool call's store, shared by every session's programs. */
  private readonly codeStore: CodeStoreRepo;
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
  /** Where a first-run agent's picture comes from: the app's own icon. The
   * server sets this once it knows its assets; a direct core in a test may
   * leave it unset. */
  private starterAgentIcon: (() => Promise<Uint8Array | undefined>) | undefined;
  /** The database file, when this core has one (see requestVacuumIfWorthwhile). */
  private readonly dbPath: string | undefined;
  /** The directory the settings file lives in, when this core has a settings
   * file at all. The first-run setup marker is read and written there (see
   * settings/setup.ts); an in-memory core has no such directory. */
  /** MCP OAuth grants (see mcp/oauth.ts), shared with the session pool. */
  private readonly mcpOAuth: McpOAuthStore;
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
  private readonly state: CoreState;
  private readonly events: EventHub;
  /** The virtual machine of stella mode: the manager, its exec seams, the
   * availability verdict and the skill catalog. Attached by the server once
   * it knows where the container files live. */
  private readonly stella: StellaMachine;
  /** Hand-over hubs per session. Dropped with the session. */
  private readonly handovers: HandoverRegistry;
  /** Environment-variable request hubs per session (`vm_env`). Dropped with
   * the session, like the hand-over hubs. */
  private readonly envRequests: EnvRequestRegistry;
  /** Folder request hubs per session (`share_request` / `share_disconnect`).
   * Dropped with the session, like the other waits. */
  private readonly shareRequests: ShareRequestRegistry;
  /** The computers lending folders to conversations (see share/hub.ts), and
   * the calls the tools make into them. In memory only: a loan belongs to the
   * app that lent it, so a restart lends nothing until that app reconnects. */
  private readonly shareHub: ShareHub;

  private constructor(graph: CoreGraph) {
    this.state = graph.state;
    this.db = graph.db;
    this.credentials = graph.credentials;
    this.computer = graph.computer;
    this.models = graph.models;
    this.personalization = graph.personalization;
    this.savedPrompts = graph.savedPrompts;
    this.push = graph.push;
    this.sessions = graph.sessions;
    this.agents = graph.agents;
    this.stellaAgents = graph.stellaAgents;
    this.messages = graph.messages;
    this.requestShapes = graph.requestShapes;
    this.codeStore = graph.codeStore;
    this.webSearch = graph.webSearch;
    this.mcpOAuth = graph.mcpOAuth;
    this.visuals = graph.visuals;
    this.attachments = graph.attachments;
    this.agentIcons = graph.agentIcons;
    this.dbPath = graph.dbPath;
    this.pool = graph.pool;
    this.mcp = graph.mcp;
    this.modelService = graph.modelService;
    this.workspaces = graph.workspaces;
    this.services = graph.services;
    this.stella = graph.stella;
    this.globalSkillDirs = graph.globalSkillDirs;
    this.appSkillDirs = graph.appSkillDirs;
    this.events = graph.events;
    this.handovers = graph.handovers;
    this.envRequests = graph.envRequests;
    this.shareRequests = graph.shareRequests;
    this.shareHub = graph.shareHub;
    this.settings = new SettingsService({
      repo: graph.settings,
      settingsDir: graph.settingsDir,
      commandSafety: graph.commandSafety,
    });
    // Built last: its runner reaches back into the facade for the two
    // operations that cross services (waking a machine, opening a
    // conversation), so every collaborator it reads is assigned above.
    this.routines = new RoutineService({
      repo: graph.routines,
      scheduler: graph.routineScheduler,
      sessions: this.sessions,
      stellaAgents: this.stellaAgents,
      pool: this.pool,
      mcp: this.mcp,
      ensureStellaReady: (agentId) => this.ensureStellaReady(agentId),
      ensureStellaSkills: (agentId) => this.ensureStellaSkills(agentId),
      openSession: (id) => this.openSession(id),
      stellaRuntimeFor: (session) => this.stellaRuntimeFor(session),
    });
  }

  /** Build the graph, then the facade over it. The host closures read the
   * core only after this constructor returns; nothing in the graph builder
   * calls them during wiring. */
  private static create(
    db: LumiscaDb,
    settings: SettingsRepo,
    overrides: CoreOverrides = {},
  ): LumiscaCore {
    let core: LumiscaCore | undefined;
    const graph = createCoreGraph(
      db,
      settings,
      overrides,
      LumiscaCore.hostFor(() => {
        if (core === undefined) {
          throw new Error("core host called before construction finished");
        }
        return core;
      }),
    );
    core = new LumiscaCore(graph);
    return core;
  }

  /** The facade's own methods, as the graph builder sees them. */
  private static hostFor(core: () => LumiscaCore): CoreHost {
    return {
      buildGeneratedPrompt: (workspace, stella) =>
        core().buildGeneratedPrompt(workspace, stella),
      browserBackend: () => core().browserBackend,
      computerHostForSession: () => core().computerHostForSession(),
      decorateSession: (session) => core().decorateSession(session),
      deleteSession: (id) => core().deleteSession(id),
      emit: (event) => core().emit(event),
      forgetSession: (sessionId) => core().forgetSession(sessionId),
      getCompactionPolicy: () => core().settings.compactionPolicy(),
      getLanguage: () => core().settings.language(),
      getOrCreateChatWorkspace: () => core().getOrCreateChatWorkspace(),
      getStellaKeepFullLog: () => core().settings.stellaKeepsFullLog(),
      isAskToolEnabled: () => core().isAskToolEnabled(),
      isCodeExecutionEnabled: () => core().isCodeExecutionEnabled(),
      requireModel: (provider, modelId) =>
        core().requireModel(provider, modelId),
      requireWorkspace: (id) => core().requireWorkspace(id),
      resolveDefaultModel: (provider, modelId) =>
        core().resolveDefaultModel(provider, modelId),
      routineRunner: () => core().routines.runner(),
      setSessionName: (id, name) => core().setSessionName(id, name),
      stellaRuntimeFor: (session) => core().stellaRuntimeFor(session),
    };
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
    return LumiscaCore.create(
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
    return LumiscaCore.create(
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
   * EMPTY. `process.env` is global to the whole test process (the runner runs
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
    stellaRun?: {
      run: VmCommandRunner;
      runBytes: VmCommandBytesRunner;
      openChannel?: VmChannelRunner;
    },
  ): LumiscaCore {
    const core = LumiscaCore.create(
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
    this.routines.close();
    // The checks' own MCP connections are not any session's (see
    // McpConnections), so nothing else closes them.
    this.mcp.close();
    // Calls into the lending apps still in flight fail now, before the
    // sessions waiting on them are torn down: a client that is shutting down
    // either side must not leave a tool awaiting a socket.
    this.shareHub.close();
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
      ...this.shareRequests.sessionIds(),
    ]);
    for (const sessionId of forgotten) this.forgetSession(sessionId);
    // The machines this process used are this application's; leaving one
    // running would keep a container (and the browser inside it) alive after
    // the app that owns it is gone. A machine this process never touched is
    // left alone: another installation on the same podman may be using it.
    // A stop that fails is logged by the server's shutdown path, not
    // swallowed here.
    await this.stella.stopAll();
    this.db.close();
    // Ran out of rows to keep: the file is now mostly free pages, which
    // SQLite reuses but never hands back. The rewrite itself waits for the
    // next start, before any request (see db/vacuum.ts) — a synchronous
    // VACUUM of a multi-gigabyte database would stall every request.
    await this.requestVacuumIfWorthwhile();
  }

  /** Bytes a prune freed in the store since this core started. */
  /** Note that the database file should be rewritten at the next start.
   *
   * A marker rather than a rewrite here: the copy of a large database takes
   * minutes and SQLite is synchronous here, so it only runs before the
   * first request is served. Below the threshold nothing is written — a
   * conversation that only grew a little is not worth a restart's delay. */
  private async requestVacuumIfWorthwhile(): Promise<void> {
    if (this.state.freedBytes < MIN_VACUUM_BYTES || this.dbPath === undefined) {
      return;
    }
    try {
      await fsp.writeFile(
        vacuumMarkerPath(this.dbPath),
        String(this.state.freedBytes),
        { mode: 0o600 },
      );
    } catch (error) {
      log.warn(`could not request a database rewrite: ${errorMessage(error)}`);
    }
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

  /** Whether the user turned the scripting tool call on (the experimental
   * toggle). */
  isCodeExecutionEnabled(): boolean {
    return codeExecutionEnabled((key) => this.settings.get(key));
  }

  /** Turn the scripting tool call on or off. The flag decides the whole tool
   * set of an agent, so every open session follows: an idle one is rebuilt at
   * once, and a running one is rebuilt when its run ends (its request
   * already carried the old tool set). */
  setCodeExecutionEnabled(enabled: boolean): void {
    this.pool.applyAgentBuildChange(
      this.services.sessions.listEverySession(),
      () => this.settings.set(CODE_EXECUTION_ENABLED_KEY, enabled ? "1" : ""),
      (id) => this.services.sessions.deferRebuild(id),
    );
  }

  /** Whether the model is offered the ask tool (the experimental toggle).
   * Unset counts as on; only "0" turns it off. */
  isAskToolEnabled(): boolean {
    return askToolEnabled((key) => this.settings.get(key));
  }

  /** Turn the ask tool on or off. The flag decides the tool set of an agent,
   * so every open session follows: an idle one is rebuilt at once, and a
   * running one is rebuilt when its run ends (its request already carried the
   * old tool set). A run blocked on an ask keeps its pending question
   * answerable until then. */
  setAskToolEnabled(enabled: boolean): void {
    this.pool.applyAgentBuildChange(
      this.services.sessions.listEverySession(),
      () => this.settings.set(ASK_TOOL_ENABLED_KEY, enabled ? "1" : "0"),
      (id) => this.services.sessions.deferRebuild(id),
    );
  }

  /** Whether the app-card guide travels in every system prompt (the
   * experimental switch). Unset counts as off, so the guide stays in the
   * on-demand `app-ui` skill. */
  isAppUiInSystemPrompt(): boolean {
    return appUiInSystemPrompt((key) => this.settings.get(key));
  }

  /** Put the app-card guide in every system prompt or back in the
   * on-demand skill. The prompt is fixed for the life of an agent, so every
   * open session follows: an idle one is rebuilt at once, and a running one
   * is rebuilt when its run ends (its request already carried the old
   * prompt). */
  setAppUiInSystemPrompt(enabled: boolean): void {
    this.pool.applyAgentBuildChange(
      this.services.sessions.listEverySession(),
      () => this.settings.set(APP_UI_IN_SYSTEM_PROMPT_KEY, enabled ? "1" : ""),
      (id) => this.services.sessions.deferRebuild(id),
    );
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
    this.shareRequests.get(sessionId)?.cancelAll();
    this.shareRequests.forget(sessionId);
  }

  // --- provider credentials ------------------------------------------------

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
  addSavedPrompt(input: {
    id: string;
    label: string;
    prompt: string;
  }): SavedPrompt {
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
  addPushSubscription(input: {
    endpoint: string;
    keys: PushSubscriptionKeys;
  }): PushSubscriptionRecord {
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
    const agent = await this.services.stellaAgents.ensureStellaAgent(
      this.starterAgentIcon,
    );
    if (before === 0) await this.prepareStellaAgentFolder(agent.id);
    return agent;
  }

  /** The picture a first-run agent starts with. The server passes its own
   * PWA icon, so the starter agent looks like the app that created it
   * instead of an initial. */
  setStarterAgentIcon(
    source: (() => Promise<Uint8Array | undefined>) | undefined,
  ): void {
    this.starterAgentIcon = source;
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
  async createStellaAgent(input: {
    name: string;
    role: string;
  }): Promise<StellaAgent> {
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
   *
   * `enabled` switches the agent off or back on. Switching it off is more
   * than a row write: its conversation is closed, which aborts a run in
   * flight and stops its background commands and MCP servers, and its
   * desktop is given back so another conversation can use the slot. The row
   * is written FIRST, so the next open reads "disabled" and builds nothing
   * while those two are being torn down.
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
    const agent = this.stellaAgents.get(id);
    if (agent === undefined) {
      throw new CoreError(`Agent not found: ${id}`, "not_found");
    }
    const model =
      patch.model === undefined ? undefined : normalizeAgentModel(patch.model);
    if (
      model !== undefined &&
      model !== null &&
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
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    });
    if (patch.enabled === false) await this.releaseStellaAgent(id);
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
    const session = this.sessions.getByPersona(agentId);
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

  /**
   * Give back everything a disabled agent was holding.
   *
   * Closing the conversation is what aborts a run in flight: `SessionAgent.
   * close()` aborts, and the pool drops the agent with its background
   * commands and MCP servers. The machine goes separately because it belongs
   * to the agent, not to the session, and a container kept awake for an agent
   * nobody can open is the one resource this state exists to free.
   *
   * The abort is issued before the machine stops. A tool call already inside
   * it may still fail when the container goes, which is the right answer for
   * a run that is being discarded: it must not keep working in the background
   * of an agent nobody can open. The machine is stopped even when closing
   * fails, because the row already says "disabled" and the next open would
   * not give it back either.
   */
  private async releaseStellaAgent(agentId: string): Promise<void> {
    const session = this.sessions.getByPersona(agentId);
    try {
      if (session !== undefined) await this.closeSession(session.id);
    } finally {
      await this.services.stellaMachines.stopAgentMachine(agentId);
    }
  }

  resolveStellaAgentIcon(
    id: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.services.stellaAgents.resolveStellaAgentIcon(id, name);
  }

  async deleteStellaAgent(id: string): Promise<void> {
    await this.services.stellaAgents.deleteStellaAgent(id);
    // The conversation is gone, so nothing can open the machine again: the
    // container goes too. Its files stay on the shared home volume.
    await this.services.stellaMachines.removeAgentMachine(id);
  }

  // --- the stella machine (delegated to StellaMachineService) --------------------

  /** Attach the stella machine (the server does this at start-up, once it
   * has resolved where the container files live). Detach with undefined. */
  setStellaVm(host: VmHost | undefined): void {
    this.services.stellaMachines.setStellaVm(host);
  }

  /** The machines' host, when one is attached. */
  getStellaVm(): VmHost | undefined {
    return this.services.stellaMachines.getStellaVm();
  }

  /** The host port of one agent's screen, or null when it has none. */
  stellaVncPort(agentId: string): Promise<number | null> {
    return this.services.stellaMachines.stellaVncPort(agentId);
  }

  /** A screen pane opened on one agent: its machine stays warm while the
   * pane is open, even without tool traffic. */
  stellaWatchScreen(agentId: string): void {
    this.services.stellaMachines.watchStellaAgent(agentId);
  }

  /** The screen pane closed: the idle clock starts from now. */
  stellaUnwatchScreen(agentId: string): void {
    this.services.stellaMachines.unwatchStellaAgent(agentId);
  }

  /** Whether stella mode can run here, with the reason when it cannot. */
  getStellaAvailability(): Promise<StellaAvailability> {
    return this.services.stellaMachines.getStellaAvailability();
  }

  async getOrCreateStellaSession(agentId?: string): Promise<SessionInfo> {
    // Before the conversation is returned (and therefore before anything is
    // read or run in it): an agent that follows the app's default model must
    // be sitting on the default as it is NOW.
    await this.followDefaultModel(agentId);
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
    if (agent === undefined || agent.disabledAt !== null) return false;
    if (agent.onboardedAt !== null) return false;
    const session = this.sessions.getByPersona(agentId);
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

  /** Wake one agent's machine (the prompt path, a routine, a wake button). */
  ensureStellaReady(agentId: string): Promise<void> {
    return this.services.stellaMachines.ensureStellaReady(agentId);
  }

  /** One agent's machine, as the screen pane draws it. */
  getStellaAgentStatus(agentId: string): Promise<StellaMachineStatus> {
    return this.services.stellaMachines.stellaAgentStatus(agentId);
  }

  /** Wake one agent's machine without a prompt. */
  wakeStellaAgent(agentId: string): Promise<void> {
    return this.services.stellaMachines.wakeStellaAgent(agentId);
  }

  /** Note that the user is driving one agent's screen, which keeps its
   * machine awake. */
  touchStellaAgent(agentId: string): void {
    this.services.stellaMachines.touchStellaAgent(agentId);
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

  /** Read one stella agent's skill catalog when this server has not read it
   * yet (see StellaMachine.ensureSkills). */
  ensureStellaSkills(agentId: string): Promise<void> {
    return this.services.stellaMachines.ensureStellaSkills(agentId);
  }

  /** The runtime a stella session's tools run on (see StellaMachineService). */
  private stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined {
    return this.services.stellaMachines.stellaRuntimeFor(session);
  }

  /** The pending hand-over of a session (the resync snapshot carries it so a
   * client that reconnects while the run is blocked can take over). */
  getPendingHandover(sessionId: string): PendingHandover | null {
    return this.services.interruptions.getPendingHandover(sessionId);
  }

  /** The user finished at the screen: let the blocked run continue. */
  finishHandover(sessionId: string, note: string, toolCallId?: string): void {
    this.services.interruptions.finishHandover(sessionId, note, toolCallId);
  }

  /** The environment variable a session's run is waiting for (the resync
   * snapshot carries it so a client that reconnects while the run is blocked
   * can still answer the dialog). */
  getPendingEnvRequest(sessionId: string): PendingEnvRequest | null {
    return this.services.interruptions.getPendingEnvRequest(sessionId);
  }

  // --- folders lent from the user's own computer (see share/hub.ts) ---------

  /** The computers lending folders, and the calls the tools make into them.
   * The server's share endpoint registers a lending app here; nothing is
   * persisted, because a loan is the lending app's to give and to withdraw. */
  get shares(): ShareHub {
    return this.shareHub;
  }

  /** The folders lent to one session. The conversation snapshot and the
   * per-session `shares` event both carry this list. */
  getShares(sessionId: string): FolderShare[] {
    return this.shareHub.sharesFor(sessionId);
  }

  /** The folder request a session's run is waiting on, or null (the resync
   * snapshot carries it so a client that reconnects while the run is blocked
   * can still answer the card). */
  getPendingShareRequest(sessionId: string): PendingShareRequest | null {
    return this.services.interruptions.getPendingShareRequest(sessionId);
  }

  /** The user lent a folder: let the blocked run continue. Throws
   * `not_found` when no lend request is waiting (the card outlived its run,
   * or another client already answered it). */
  finishShareLend(sessionId: string, toolCallId?: string): void {
    this.services.interruptions.finishShareLend(sessionId, toolCallId);
  }

  /** The user pressed the button that declines: the run continues without a
   * folder. */
  declineShareRequest(sessionId: string, toolCallId?: string): void {
    this.services.interruptions.declineShareRequest(sessionId, toolCallId);
  }

  /** The desktop app withdrew the loan: let the blocked run continue. */
  finishShareDisconnect(sessionId: string, toolCallId: string): void {
    this.services.interruptions.finishShareDisconnect(sessionId, toolCallId);
  }

  /** The desktop app could not withdraw the loan, and said why: the run
   * continues with that reason in the tool's result. */
  failShareDisconnect(
    sessionId: string,
    toolCallId: string,
    error: string,
  ): void {
    this.services.interruptions.failShareDisconnect(
      sessionId,
      toolCallId,
      error,
    );
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
  getThinkingState(sessionId: string): {
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  } {
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

  /** Open a session, unless it is a stella conversation whose agent is
   * disabled.
   *
   * A disabled agent has nothing to open into: building its agent would undo
   * the release the disable performed, and its conversation is served from
   * the store instead (see readStellaConversationFromStore). Refusing here
   * is what keeps every path that opens a session — a rewind, a routine that
   * was already queued — from rebuilding it.
   */
  openSession(id: string): SessionInfo {
    const session = this.sessions.get(id);
    if (session?.personaId !== undefined) {
      const agent = this.stellaAgents.get(session.personaId);
      if (agent !== undefined && agent.disabledAt !== null) {
        throw new CoreError(`Agent ${agent.id} is disabled`, "conflict");
      }
    }
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

  /** One window of a conversation that is not open, read from the store
   * alone. A disabled agent's conversation is the only such case. */
  readStellaConversationFromStore(
    id: string,
    query: WindowQuery,
  ): WindowPage<StellaEntry> {
    return this.services.sessions.readStellaConversationFromStore(id, query);
  }

  /** Put a prompt's attached pictures into the machine. */
  savePromptImages(
    id: string,
    uploads: readonly PromptImageFile[],
  ): Promise<PromptFileRef[]> {
    return this.services.sessions.savePromptImages(id, uploads);
  }

  /** Copy one prompt file from this host into the machine. */
  savePromptFile(
    id: string,
    file: HostPromptFile,
    signal?: AbortSignal,
  ): Promise<PromptFileRef> {
    return this.services.sessions.savePromptFile(id, file, signal);
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
      if (session.modelProvider === providerId && session.modelId === modelId) {
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
   * The identity of a stella agent is included even though it can change
   * while the session lives: the prompt keeps the text it was generated
   * with, and a compaction regenerates it (see
   * SessionAgentOptions.refreshSystemPrompt). Everything else that varies
   * while a session lives is outside this function for the same reason: a
   * session open can re-derive the prompt and compare it against the stored
   * one only if unchanged inputs give an identical string. */
  private buildGeneratedPrompt(
    workspace: Workspace,
    stella: boolean | { role: string; identity: string; id: string } = false,
  ): string {
    // Neither the language nor the model is read here: both are published as
    // context messages (agent/language-context.ts, agent/model-context.ts),
    // because both can change while the session lives. That is also what
    // keeps this string stable across opens — which is what lets
    // ensureSystemPrompt compare it against the stored value.
    // The app-card guide is the one exception, and only because moving it
    // rebuilds the open sessions (setAppUiInSystemPrompt): it is fixed for
    // the life of an agent like the tool set is.
    const appUiGuide = this.isAppUiInSystemPrompt();
    // stella's conversation row shares the folder-less chat workspace, but
    // its prompt is the machine's: a chat prompt would tell it it cannot
    // run anything, which is the opposite of what it can do.
    if (stella !== false) {
      return buildStellaSystemPrompt(
        stella === true
          ? { appUiGuide }
          : {
              agent: { role: stella.role, identity: stella.identity },
              workdir: vmAgentDir(stella.id),
              appUiGuide,
            },
      );
    }
    return workspace.chat
      ? buildChatSystemPrompt({ appUiGuide })
      : buildSystemPrompt(workspace, { appUiGuide });
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
    const preferred = await this.explicitDefaultModel();
    if (preferred !== undefined) return preferred;
    const latest = this.sessions.list()[0];
    if (
      latest &&
      this.models.getModel(latest.modelProvider, latest.modelId) &&
      (await this.models.hasConfiguredAuth(latest.modelProvider))
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

  /** The model the user named as the app default, when it can run here.
   * A default naming a model this installation cannot reach (a provider
   * removed since, a retired id, no credentials) answers undefined: the
   * caller falls through to what it would have chosen without the setting,
   * rather than failing on a value the user cannot see from here.
   *
   * One definition for both readers — choosing a model for a new session
   * ({@link resolveDefaultModel}) and moving a stella conversation onto it
   * ({@link followDefaultModel}) — so the two cannot disagree about what
   * "the default" means. */
  private async explicitDefaultModel(): Promise<
    { provider: string; modelId: string } | undefined
  > {
    const preferred = parseModelPreference(
      this.settings.get(DEFAULT_MODEL_KEY),
    );
    if (preferred === undefined) return undefined;
    if (
      this.models.getModel(preferred.provider, preferred.modelId) === undefined
    ) {
      return undefined;
    }
    if (!(await this.models.hasConfiguredAuth(preferred.provider))) {
      return undefined;
    }
    return { provider: preferred.provider, modelId: preferred.modelId };
  }

  /**
   * Move an agent's conversation onto the app's default model, when the agent
   * has no model of its own.
   *
   * "Unset means the app's default model" is what the agent dialog promises
   * (see chat.stella.agents.modelDefault), but the conversation row stores the
   * pair it resolved when it was created and a run reads that row. Changing
   * the default afterwards therefore left the row on the old model while the
   * agent still said "default" — the row was right about what runs and wrong
   * about why. The row is the model a run reads, so it is moved to whatever
   * the default is now, at the moment the conversation is opened.
   *
   * Only the row is written when it differs: an unchanged pair is not a
   * write, and a run in flight keeps its model until it ends (see
   * SessionService.setSessionModel).
   */
  private async followDefaultModel(agentId?: string): Promise<void> {
    const agent =
      agentId === undefined
        ? this.stellaAgents.latest()
        : this.stellaAgents.get(agentId);
    if (agent === undefined || agent.model !== null) return;
    const session = this.sessions.getByPersona(agent.id);
    if (session === undefined) return;
    const preferred = await this.explicitDefaultModel();
    if (preferred === undefined) return;
    if (
      session.modelProvider === preferred.provider &&
      session.modelId === preferred.modelId
    ) {
      return;
    }
    this.services.sessions.setSessionModel(
      session.id,
      preferred.provider,
      preferred.modelId,
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
      chat: this.services.workspaces.get(session.workspaceId)?.chat ?? false,
      ...(session.stella === true ? { stella: true } : {}),
    };
  }
}
