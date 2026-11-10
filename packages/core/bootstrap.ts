import type { Api, Model } from "./ai/types.ts";
import type { MessageRepo } from "./session/messages.ts";
import type { SessionRepo } from "./session/repo.ts";
import type { SessionVisualStore } from "./session/visuals.ts";
import type { SessionAttachmentStore } from "./session/attachments.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { Workspace } from "./domain/workspace.ts";
import type { ClientEvent } from "./domain/event.ts";
import type { Locale } from "./shared/mod.ts";
import type { RoutineRepo } from "./routine/repo.ts";
import type { RoutineScheduler } from "./routine/scheduler.ts";
import type { AgentRepo } from "./stella/agents.ts";
import type { AgentIconStore } from "./stella/icons.ts";
import type { McpService } from "./mcp/service.ts";
import type { ModelService } from "./services/models.ts";
import { SessionService } from "./services/sessions.ts";
import { StellaAgentService } from "./services/stella-agents.ts";
import { StellaMachineService } from "./services/stella-machines.ts";
import type { WebSearchService } from "./websearch/service.ts";
import type { SessionPool } from "./agent/pool.ts";
import type { StellaMachine } from "./vm/machine.ts";
import type { HandoverRegistry } from "./vm/handover-registry.ts";
import type { ModelManager } from "./models/mod.ts";
import type { WorkspaceService } from "./services/workspaces.ts";

/** The areas of the core, as `LumiscaCore.services` exposes them. */
export interface CoreServices {
  readonly sessions: SessionService;
  readonly stellaAgents: StellaAgentService;
  readonly stellaMachines: StellaMachineService;
  readonly models: ModelService;
  readonly webSearch: WebSearchService;
  readonly mcp: McpService;
  readonly workspaces: WorkspaceService;
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
  agents: AgentRepo;
  sessions: SessionRepo;
  messages: MessageRepo;
  pool: SessionPool;
  routines: RoutineRepo;
  routineScheduler: RoutineScheduler;
  handovers: HandoverRegistry;
  icons: AgentIconStore;
  visuals: SessionVisualStore;
  attachments: SessionAttachmentStore;
  models: ModelManager;
  workspaces: WorkspaceService;
  modelService: ModelService;
  webSearch: WebSearchService;
  mcp: McpService;

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
      getThinkingLevel: (provider, modelId) =>
        deps.models.getThinkingLevel(provider, modelId),
    },
    requireModel: deps.requireModel,
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
  const deleteSession = (id: string) => sessions.deleteSession(id);
  const stellaAgents = new StellaAgentService({
    agents: deps.agents,
    icons: deps.icons,
    sessions: deps.sessions,
    messages: deps.messages,
    deleteSession,
    language: deps.language,
    emit: deps.emit,
  });
  // The closure is not called during construction: `createStellaAgent` runs
  // only when a user (or the tool) creates one, long after.
  const machines: StellaMachineService = new StellaMachineService({
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
    decorateSession: deps.decorateSession,
    deleteSession,
    emit: deps.emit,
    language: deps.language,
    chatWorkspace: deps.chatWorkspace,
    requireWorkspace: deps.requireWorkspace,
    resolveDefaultModel: deps.resolveDefaultModel,
    createStellaAgent: async (input) => {
      const agent = await stellaAgents.createStellaAgent(input);
      await machines.prepareAgentFolder(agent.id);
      return agent;
    },
  });
  return {
    sessions,
    stellaAgents,
    stellaMachines: machines,
    models: deps.modelService,
    webSearch: deps.webSearch,
    mcp: deps.mcp,
    workspaces: deps.workspaces,
  };
}
