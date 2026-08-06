import { LumiscaDb } from "./db/mod.ts";
import type { ClientEvent } from "./types/event.ts";
import type { SessionInfo } from "./types/session.ts";
import type { Workspace } from "./types/workspace.ts";
import { createSettingsRepo, type SettingsRepo } from "./settings/repo.ts";
import {
  createDbCredentialStore,
  getApiKey,
  setApiKey,
} from "./settings/credentials.ts";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import { createDbModelsStore, ModelManager } from "./models/mod.ts";
import { createWorkspaceRepo, type WorkspaceRepo } from "./workspace/repo.ts";
import { Sandbox } from "./workspace/sandbox.ts";
import { createSessionRepo, type SessionRepo } from "./session/repo.ts";
import { createMessageRepo, type MessageRepo } from "./session/messages.ts";
import { SessionAgent } from "./agent/session-agent.ts";
import { buildSystemPrompt, createCodingTools } from "./tools/mod.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CreateSessionInput {
  workspaceId: string;
  name?: string;
  /** Omitted → the last-used model (or the first enabled model) is used. */
  modelProvider?: string;
  modelId?: string;
  systemPrompt?: string;
}

/**
 * Root object shared by every frontend (web server, CLI, desktop).
 * Owns the database, models, workspaces, and live session agents.
 */
export class LumiscaCore {
  readonly db: LumiscaDb;
  readonly settings: SettingsRepo;
  readonly models: ModelManager;

  private readonly credentials: CredentialStore;
  private readonly workspaces: WorkspaceRepo;
  private readonly sessions: SessionRepo;
  private readonly messages: MessageRepo;
  private readonly agents = new Map<string, SessionAgent>();
  private readonly listeners = new Set<(event: ClientEvent) => void>();

  private constructor(db: LumiscaDb) {
    this.db = db;
    this.settings = createSettingsRepo(db);
    this.credentials = createDbCredentialStore(this.settings);
    const modelsStore = createDbModelsStore(this.settings);
    this.models = new ModelManager(
      this.credentials,
      this.settings,
      modelsStore,
    );
    this.workspaces = createWorkspaceRepo(db);
    this.sessions = createSessionRepo(db);
    this.messages = createMessageRepo(db);
  }

  static open(dbPath: string): LumiscaCore {
    return new LumiscaCore(LumiscaDb.open(dbPath));
  }

  static openInMemory(): LumiscaCore {
    return new LumiscaCore(LumiscaDb.openInMemory());
  }

  /** Test-only: in-memory core with extra providers (e.g. the faux provider). */
  static forTesting(extraProviders: Provider[] = []): LumiscaCore {
    const core = new LumiscaCore(LumiscaDb.openInMemory());
    for (const provider of extraProviders) {
      core.models.models.setProvider(provider);
    }
    return core;
  }

  close(): void {
    for (const agent of this.agents.values()) {
      agent.abort();
    }
    this.agents.clear();
    this.db.close();
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore sink failures
      }
    }
  }

  // --- settings -----------------------------------------------------------

  getSetting(key: string): string | undefined {
    return this.settings.get(key);
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  deleteSetting(key: string): void {
    this.settings.delete(key);
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    await setApiKey(this.credentials, providerId, key);
  }

  async getProviderApiKey(providerId: string): Promise<string | undefined> {
    return await getApiKey(this.credentials, providerId);
  }

  async listProviderCredentials(): Promise<string[]> {
    const infos = await this.credentials.list();
    return infos.map((i) => i.providerId);
  }

  // --- workspaces ---------------------------------------------------------

  async createWorkspace(name: string, folders: string[]): Promise<Workspace> {
    const resolved = await this.resolveFolders(folders);
    return this.workspaces.create(name, resolved);
  }

  listWorkspaces(): Workspace[] {
    return this.workspaces.list();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  /** Update a workspace (name and/or folders); running sessions get rebuilt
   * tools when the folders change. Returns the updated workspace. */
  async updateWorkspace(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace> {
    const current = this.requireWorkspace(id);
    const name = input.name ?? current.name;
    const folders = input.folders !== undefined
      ? await this.resolveFolders(input.folders)
      : current.folders;
    this.workspaces.update(id, name, folders);
    for (const session of this.sessions.list(id)) {
      this.rebuildAgent(session);
    }
    return this.workspaces.get(id)!;
  }

  deleteWorkspace(id: string): void {
    for (const session of this.sessions.list(id)) {
      this.agents.get(session.id)?.abort();
      this.agents.delete(session.id);
    }
    this.workspaces.delete(id);
  }

  // --- sessions -----------------------------------------------------------

  /** The model a new session would get: the last used model, or the first
   * enabled model. Null when no model can be resolved. */
  getDefaultModel(): { provider: string; modelId: string } | null {
    try {
      return this.resolveDefaultModel();
    } catch {
      return null;
    }
  }

  createSession(input: CreateSessionInput): SessionInfo {
    const workspace = this.requireWorkspace(input.workspaceId);
    const model = this.resolveDefaultModel(input.modelProvider, input.modelId);
    const systemPrompt = input.systemPrompt ?? buildSystemPrompt(workspace);
    const session = this.sessions.create({
      workspaceId: workspace.id,
      name: input.name ?? `Session ${new Date().toLocaleString()}`,
      modelProvider: model.provider,
      modelId: model.modelId,
      systemPrompt,
    });
    this.agents.set(session.id, this.buildAgent(session, workspace, []));
    this.emit({ type: "session_created", session });
    return session;
  }

  listSessions(workspaceId?: string): SessionInfo[] {
    return this.sessions.list(workspaceId);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  /** Load a persisted session into memory (restores message history). */
  openSession(id: string): SessionInfo {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (!this.agents.has(id)) {
      const workspace = this.requireWorkspace(session.workspaceId);
      const messages = this.messages.listMessages(id);
      this.agents.set(id, this.buildAgent(session, workspace, messages));
    }
    return session;
  }

  closeSession(id: string): void {
    this.agents.get(id)?.abort();
    this.agents.delete(id);
  }

  deleteSession(id: string): void {
    this.agents.delete(id);
    this.sessions.delete(id);
  }

  getAgent(id: string): SessionAgent | undefined {
    return this.agents.get(id);
  }

  async prompt(id: string, text: string): Promise<void> {
    const agent = this.requireAgent(id);
    this.sessions.touch(id);
    await agent.prompt(text);
  }

  steer(id: string, text: string): void {
    this.requireAgent(id).steer(text);
  }

  followUp(id: string, text: string): void {
    this.requireAgent(id).followUp(text);
  }

  abort(id: string): void {
    this.requireAgent(id).abort();
  }

  /** Switch the model used by a session (persisted). */
  setSessionModel(id: string, provider: string, modelId: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    const model = this.models.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    this.sessions.updateModel(id, provider, modelId);
    this.rebuildAgent({ ...session, modelProvider: provider, modelId });
  }

  /** Rename a session (persisted). */
  setSessionName(id: string, name: string): void {
    this.sessions.rename(id, name);
  }

  // --- model enablement ----------------------------------------------------

  /** Enable or disable a model for the UI. Disabled models are hidden
   * from model pickers. Enabled is the default (nothing stored). */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
    this.models.setModelEnabled(providerId, modelId, enabled);
  }

  isModelEnabled(providerId: string, modelId: string): boolean {
    return this.models.isModelEnabled(providerId, modelId);
  }

  /** List models of a provider with their enabled state. */
  listModelsWithState(
    providerId: string,
  ): Array<{ id: string; enabled: boolean }> {
    return this.listModelsDetailed(providerId).map(({ id, enabled }) => ({
      id,
      enabled,
    }));
  }

  /** Models of a provider with enablement info, for the settings UI. */
  listModelsDetailed(providerId: string): Array<{
    id: string;
    name: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: string[];
    enabled: boolean;
  }> {
    return this.models.getModels(providerId).map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      input: m.input,
      enabled: this.isModelEnabled(providerId, m.id),
    }));
  }

  // --- internals ----------------------------------------------------------

  private requireWorkspace(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);
    return workspace;
  }

  /** Resolve workspace folders to real paths; rejects missing ones. */
  private async resolveFolders(folders: string[]): Promise<string[]> {
    const resolved: string[] = [];
    for (const folder of folders) {
      const sandbox = new Sandbox([folder]);
      const r = await sandbox.resolveFolder(folder);
      if (!r.ok) throw new Error(r.reason);
      resolved.push(r.path);
    }
    return [...new Set(resolved)];
  }

  /** Resolve the model for a new session: explicit choice, else the
   * last-used model, else the first enabled model of the first provider. */
  private resolveDefaultModel(
    provider?: string,
    modelId?: string,
  ): { provider: string; modelId: string } {
    if (provider && modelId) {
      const model = this.models.getModel(provider, modelId);
      if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
      return { provider, modelId };
    }
    const latest = this.sessions.list()[0];
    if (latest && this.models.getModel(latest.modelProvider, latest.modelId)) {
      return { provider: latest.modelProvider, modelId: latest.modelId };
    }
    for (const p of this.models.getProviders()) {
      const model = this.models.getModels(p.id).find((m) =>
        this.isModelEnabled(p.id, m.id)
      );
      if (model) return { provider: p.id, modelId: model.id };
    }
    throw new Error("No models available");
  }

  private requireAgent(id: string): SessionAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Session is not open: ${id}`);
    return agent;
  }

  private buildAgent(
    session: SessionInfo,
    workspace: Workspace,
    messages: AgentMessage[],
  ): SessionAgent {
    const model = this.models.getModel(
      session.modelProvider,
      session.modelId,
    );
    if (!model) {
      throw new Error(
        `Model not found: ${session.modelProvider}/${session.modelId}`,
      );
    }
    const { tools } = createCodingTools(workspace);
    return new SessionAgent({
      sessionId: session.id,
      systemPrompt: session.systemPrompt ?? buildSystemPrompt(workspace),
      model,
      tools,
      messages,
      streamFn: this.models.models.streamSimple.bind(this.models.models),
      messageRepo: this.messages,
      onEvent: (event) => this.emit(event),
    });
  }

  private rebuildAgent(session: SessionInfo): void {
    const workspace = this.requireWorkspace(session.workspaceId);
    const current = this.agents.get(session.id);
    if (current) {
      const messages = current.messages;
      this.agents.delete(session.id);
      this.agents.set(
        session.id,
        this.buildAgent(session, workspace, messages),
      );
    }
  }
}
