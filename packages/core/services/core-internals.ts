import type { Model } from "../ai/catalog.ts";
import type { CoreServices } from "../bootstrap.ts";
import type { Api } from "../domain/model.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { CoreError } from "../errors.ts";
import type { ModelManager } from "../models/mod.ts";
import type { SessionRepo } from "../session/repo.ts";
import { DEFAULT_MODEL_KEY, parseModelPreference } from "../shared/mod.ts";
import {
  buildChatSystemPrompt,
  buildStellaSystemPrompt,
  buildSystemPrompt,
} from "../tools/mod.ts";
import { vmAgentDir } from "../vm/contract.ts";
import type { StellaRuntime } from "../vm/runtime.ts";
import type { Capabilities } from "./capabilities.ts";
import type { ModelService } from "./models.ts";
import { sessionModelView } from "./session-model-view.ts";
import type { SettingsService } from "./settings.ts";
import type { WorkspaceService } from "./workspaces.ts";

export interface CoreInternalsDeps {
  services: CoreServices;
  settings: SettingsService;
  capabilities: Capabilities;
  models: ModelManager;
  modelService: ModelService;
  sessions: SessionRepo;
  workspaces: WorkspaceService;
}

/**
 * The operations that cross more than one service and belong to no single
 * one: the system prompt a session is built from, the model a new session
 * resolves to, the row a client is shown, and the stella conversation an
 * agent opens. They read the services; they own no state of their own.
 */
export class CoreInternals {
  readonly #deps: CoreInternalsDeps;

  constructor(deps: CoreInternalsDeps) {
    this.#deps = deps;
  }

  requireWorkspace(id: string): Workspace {
    return this.#deps.workspaces.require(id);
  }

  requireModel(provider: string, modelId: string): Model<Api> {
    const model = this.#deps.models.getModelWithRetired(provider, modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${provider}/${modelId}`,
        "not_found",
      );
    }
    return model;
  }

  getOrCreateChatWorkspace(): Workspace {
    return this.#deps.workspaces.getOrCreateChatWorkspace();
  }

  /** The generated system prompt for a workspace (see LumiscaCore's old
   * contract): the chat variant for a folder-less workspace, the machine
   * variant for a stella agent. */
  buildGeneratedPrompt(
    workspace: Workspace,
    stella: boolean | { role: string; identity: string; id: string } = false,
  ): string {
    const appUiGuide = this.#deps.capabilities.isAppUiInSystemPrompt();
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

  async resolveDefaultModel(
    provider?: string,
    modelId?: string,
  ): Promise<{ provider: string; modelId: string }> {
    if (provider && modelId) {
      const live = this.#deps.models.getModel(provider, modelId);
      if (live === undefined) {
        throw new CoreError(
          `Model not found: ${provider}/${modelId}`,
          "not_found",
        );
      }
      return { provider, modelId };
    }
    const preferred = await this.explicitDefaultModel();
    if (preferred !== undefined) return preferred;
    const latest = this.#deps.sessions.list()[0];
    if (
      latest &&
      this.#deps.models.getModel(latest.modelProvider, latest.modelId) &&
      (await this.#deps.models.hasConfiguredAuth(latest.modelProvider))
    ) {
      return { provider: latest.modelProvider, modelId: latest.modelId };
    }
    const fallback = await this.#deps.models.getFallbackModel();
    if (fallback) return fallback;
    throw new CoreError(
      "No models available: no provider is configured",
      "unavailable",
    );
  }

  private async explicitDefaultModel(): Promise<
    { provider: string; modelId: string } | undefined
  > {
    const preferred = parseModelPreference(
      this.#deps.settings.get(DEFAULT_MODEL_KEY),
    );
    if (preferred === undefined) return undefined;
    if (
      this.#deps.models.getModel(preferred.provider, preferred.modelId) ===
      undefined
    ) {
      return undefined;
    }
    if (!(await this.#deps.models.hasConfiguredAuth(preferred.provider))) {
      return undefined;
    }
    return { provider: preferred.provider, modelId: preferred.modelId };
  }

  async followDefaultModel(agentId?: string): Promise<void> {
    const agent =
      agentId === undefined
        ? this.#deps.services.stellaAgents.latestAgent()
        : this.#deps.services.stellaAgents.getStellaAgent(agentId);
    if (agent === undefined || agent.model !== null) return;
    const session = this.#deps.sessions.getByPersona(agent.id);
    if (session === undefined) return;
    const preferred = await this.explicitDefaultModel();
    if (preferred === undefined) return;
    if (
      session.modelProvider === preferred.provider &&
      session.modelId === preferred.modelId
    ) {
      return;
    }
    this.#deps.services.sessions.setSessionModel(
      session.id,
      preferred.provider,
      preferred.modelId,
    );
  }

  /** Open (or create) a stella agent's conversation, after moving it onto
   * the app's default model when the agent has none of its own. */
  async getOrCreateStellaSession(agentId?: string): Promise<SessionInfo> {
    await this.followDefaultModel(agentId);
    return this.#deps.services.stellaMachines.getOrCreateStellaSession(agentId);
  }

  /** The runtime a stella session tools run on. */
  stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined {
    return this.#deps.services.stellaMachines.stellaRuntimeFor(session);
  }

  decorateSession(session: SessionInfo): SessionInfo {
    return {
      ...session,
      ...sessionModelView(
        this.#deps.models,
        session.modelProvider,
        session.modelId,
      ),
      chat:
        this.#deps.services.workspaces.get(session.workspaceId)?.chat ?? false,
      ...(session.stella === true ? { stella: true } : {}),
    };
  }
}
