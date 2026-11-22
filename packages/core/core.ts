import type { SessionPool } from "./agent/pool.ts";
import type { CredentialStore } from "./ai/catalog.ts";
import type { CoreGraph, CoreServices, CoreState } from "./bootstrap.ts";
import type { CodeStoreRepo } from "./code-execution/store.ts";
import type { LumiscaDb } from "./db/mod.ts";
import type { ClientEvent } from "./domain/event.ts";
import type { EventHub } from "./events/hub.ts";
import { createLogger } from "./log.ts";
import type { McpOAuthStore } from "./mcp/oauth.ts";
import type { McpService } from "./mcp/service.ts";
import type { ModelManager } from "./models/mod.ts";
import { Capabilities } from "./services/capabilities.ts";
import { CoreInternals } from "./services/core-internals.ts";
import { closeCore } from "./services/core-lifecycle.ts";
import type { ModelService } from "./services/models.ts";
import { RoutineService } from "./services/routines.ts";
import { SettingsService } from "./services/settings.ts";
import type { WorkspaceService } from "./services/workspaces.ts";
import type { AgentRepo } from "./session/agents.ts";
import type { SessionAttachmentStore } from "./session/attachments.ts";
import type { MessageRepo } from "./session/messages.ts";
import type { SessionRepo } from "./session/repo.ts";
import type { RequestShapeRepo } from "./session/request-shapes.ts";
import type { SessionVisualStore } from "./session/visuals.ts";
import type { ShareHub } from "./share/hub.ts";
import type { ShareRequestRegistry } from "./share/request.ts";
import type { ThinkingLevel } from "./shared/mod.ts";
import type { AgentIconStore } from "./stella/icons.ts";
import type { EnvRequestRegistry } from "./vm/env-request.ts";
import type { HandoverRegistry } from "./vm/handover-registry.ts";
import type { StellaMachine } from "./vm/machine.ts";
import type { WebSearchService } from "./websearch/service.ts";

/** Module logger (debug-gated). */
const _log = createLogger("core");

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
  private readonly sessions: SessionRepo;
  /** The sessions' agents: each session's main row and its sub-agents (see
   * session/agents.ts). */
  private readonly agents: AgentRepo;
  /** The extracted areas of this facade (see CoreServices). */
  readonly services: CoreServices;
  /** The operations that cross services (see CoreInternals). */
  readonly internals: CoreInternals;
  /** What this installation lets an agent do (see Capabilities). */
  readonly capabilities: Capabilities;
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
  /** The model operations the facade's collaborators call. */
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
  /** The database file, when this core has one. */
  private readonly dbPath: string | undefined;
  /** MCP OAuth grants (see mcp/oauth.ts), shared with the session pool. */
  private readonly mcpOAuth: McpOAuthStore;
  /** The web-search setting and the provider built over it. */
  private readonly webSearch: WebSearchService;
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

  constructor(graph: CoreGraph) {
    this.state = graph.state;
    this.db = graph.db;
    this.credentials = graph.credentials;
    this.models = graph.models;
    this.sessions = graph.sessions;
    this.agents = graph.agents;
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
    this.capabilities = new Capabilities({
      computer: graph.computer,
      settings: this.settings,
      sessions: this.services.sessions,
      pool: this.pool,
    });
    this.internals = new CoreInternals({
      services: this.services,
      settings: this.settings,
      capabilities: this.capabilities,
      models: this.models,
      modelService: this.modelService,
      sessions: this.sessions,
      workspaces: this.workspaces,
    });
    // Built last: its runner reaches back into the facade for the two
    // operations that cross services (waking a machine, opening a
    // conversation), so every collaborator it reads is assigned above.
    this.routines = new RoutineService({
      repo: graph.routines,
      scheduler: graph.routineScheduler,
      sessions: this.sessions,
      stellaAgents: graph.stellaAgents,
      pool: this.pool,
      mcp: this.mcp,
      ensureStellaReady: (agentId) =>
        this.services.stellaMachines.ensureStellaReady(agentId),
      ensureStellaSkills: (agentId) =>
        this.services.stellaMachines.ensureStellaSkills(agentId),
      openSession: (id) => this.services.sessions.openSession(id),
      stellaRuntimeFor: (session) => this.internals.stellaRuntimeFor(session),
    });
  }

  /** Shut the core down (see closeCore). */
  async close(): Promise<void> {
    await closeCore({
      routines: this.routines,
      mcp: this.mcp,
      shareHub: this.shareHub,
      pool: this.pool,
      events: this.events,
      handovers: this.handovers,
      envRequests: this.envRequests,
      shareRequests: this.shareRequests,
      stella: this.stella,
      db: this.db,
      state: this.state,
      dbPath: this.dbPath,
      forgetSession: (sessionId) => this.forgetSession(sessionId),
    });
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: ClientEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  /** Hand an event to every subscriber and count it (see EventHub). */
  emit(event: ClientEvent): void {
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
  forgetSession(sessionId: string): void {
    this.events.forgetSession(sessionId);
    this.handovers.forget(sessionId);
    this.envRequests.get(sessionId)?.cancelAll();
    this.envRequests.forget(sessionId);
    this.shareRequests.get(sessionId)?.cancelAll();
    this.shareRequests.forget(sessionId);
  }

  /** The computers lending folders, and the calls the tools make into them.
   * The server's share endpoint registers a lending app here; nothing is
   * persisted, because a loan is the lending app's to give and to withdraw. */
  get shares(): ShareHub {
    return this.shareHub;
  }
}
