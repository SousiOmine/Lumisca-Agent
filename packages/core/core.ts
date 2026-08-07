import { LumiscaDb } from "./db/mod.ts";
import type { ClientEvent } from "./types/event.ts";
import type { SessionInfo } from "./types/session.ts";
import type { Workspace } from "./types/workspace.ts";
import { createSettingsRepo, type SettingsRepo } from "./settings/repo.ts";
import {
  createDbCredentialStore,
  CREDENTIAL_KEY_PREFIX,
  setApiKey,
} from "./settings/credentials.ts";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import type { Api, AuthCheck, Model } from "@earendil-works/pi-ai";
import { createDbModelsStore, ModelManager } from "./models/mod.ts";
import {
  getSupportedThinkingLevels,
  isThinkingLevel,
} from "./models/thinking.ts";
import type { ThinkingLevel } from "./shared.ts";
import { createWorkspaceRepo, type WorkspaceRepo } from "./workspace/repo.ts";
import { Sandbox } from "./workspace/sandbox.ts";
import { createSessionRepo, type SessionRepo } from "./session/repo.ts";
import { createMessageRepo, type MessageRepo } from "./session/messages.ts";
import { SessionAgent } from "./agent/session-agent.ts";
import { buildSystemPrompt, createCodingTools } from "./tools/mod.ts";
import { CoreError } from "./errors.ts";
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
  readonly models: ModelManager;

  private readonly settings: SettingsRepo;
  private readonly credentials: CredentialStore;
  private readonly workspaces: WorkspaceRepo;
  private readonly sessions: SessionRepo;
  private readonly messages: MessageRepo;
  private readonly agents = new Map<string, SessionAgent>();
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private readonly lastErrors = new Map<string, string>();

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

  /** Read a setting. Credential keys are refused — they have their own API
   * (/providers/:id/api-key) and must never be readable through the generic
   * settings surface. */
  getSetting(key: string): string | undefined {
    this.assertNotCredential(key);
    return this.settings.get(key);
  }

  setSetting(key: string, value: string): void {
    this.assertNotCredential(key);
    this.settings.set(key, value);
  }

  deleteSetting(key: string): void {
    this.assertNotCredential(key);
    this.settings.delete(key);
  }

  private assertNotCredential(key: string): void {
    if (key.startsWith(CREDENTIAL_KEY_PREFIX)) {
      // Credentials have their own API (/providers/:id/api-key); touching
      // them through the generic settings surface would bypass it.
      throw new CoreError(
        "credentials cannot be accessed through this endpoint",
        "forbidden",
      );
    }
  }

  /** Non-credential settings only; credentials are never exposed. */
  listSettings(): Map<string, string> {
    const safe = new Map<string, string>();
    for (const [key, value] of this.settings.list()) {
      if (!key.startsWith(CREDENTIAL_KEY_PREFIX)) safe.set(key, value);
    }
    return safe;
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    await setApiKey(this.credentials, providerId, key);
  }

  // --- workspaces ---------------------------------------------------------

  async createWorkspace(name: string, folders: string[]): Promise<Workspace> {
    const resolved = await this.resolveFolders(folders);
    if (resolved.length === 0) {
      throw new CoreError(
        "Workspace must contain at least one folder",
        "invalid",
      );
    }
    return this.workspaces.create(name, resolved);
  }

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
    const current = this.requireWorkspace(id);
    const name = input.name ?? current.name;
    const folders = input.folders !== undefined
      ? await this.resolveFolders(input.folders)
      : current.folders;
    if (folders.length === 0) {
      throw new CoreError(
        "Workspace must contain at least one folder",
        "invalid",
      );
    }
    const sessions = this.sessions.list(id);
    this.assertNoStreaming(sessions);
    this.workspaces.update(id, name, folders);
    for (const session of sessions) {
      this.rebuildAgent(session);
    }
    return this.workspaces.get(id)!;
  }

  deleteWorkspace(id: string): void {
    for (const session of this.sessions.list(id)) {
      this.agents.get(session.id)?.abort();
      this.agents.delete(session.id);
      this.lastErrors.delete(session.id);
    }
    this.workspaces.delete(id);
  }

  // --- sessions -----------------------------------------------------------

  /** The model a new session would get: the last used model, or the first
   * enabled model. Null when no model can be resolved. Includes the model's
   * thinking level so the draft tab can show the right control. */
  getDefaultModel(): {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  } | null {
    try {
      const model = this.resolveDefaultModel();
      return {
        ...model,
        thinkingLevel: this.models.getThinkingLevel(
          model.provider,
          model.modelId,
        ),
        thinkingLevels: getSupportedThinkingLevels(
          this.models.getModel(model.provider, model.modelId),
        ),
      };
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
    return this.decorateSession(session);
  }

  listSessions(workspaceId?: string): SessionInfo[] {
    return this.sessions.list(workspaceId).map((s) => this.decorateSession(s));
  }

  getSession(id: string): SessionInfo | undefined {
    const session = this.sessions.get(id);
    return session ? this.decorateSession(session) : undefined;
  }

  /** Load a persisted session into memory (restores message history). */
  openSession(id: string): SessionInfo {
    const session = this.sessions.get(id);
    if (!session) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (!this.agents.has(id)) {
      const workspace = this.requireWorkspace(session.workspaceId);
      const messages = this.messages.listMessages(id);
      this.agents.set(id, this.buildAgent(session, workspace, messages));
    }
    return this.decorateSession(session);
  }

  closeSession(id: string): void {
    this.agents.get(id)?.abort();
    this.agents.delete(id);
  }

  deleteSession(id: string): void {
    this.agents.get(id)?.abort();
    this.agents.delete(id);
    this.lastErrors.delete(id);
    this.sessions.delete(id);
  }

  getAgent(id: string): SessionAgent | undefined {
    return this.agents.get(id);
  }

  /** The last failure of a session, if any. Cleared when a new run starts.
   * Lets non-WebSocket clients (curl, the desktop shell) learn about
   * failures of fire-and-forget prompts instead of losing them. */
  getSessionLastError(id: string): string | undefined {
    return this.lastErrors.get(id);
  }

  /** Fire-and-forget prompt: completion and failures arrive as events
   * (agent_end / session_error). The HTTP layer should use this instead of
   * holding a connection open for the whole run. Throws when the session
   * is already streaming. */
  startPrompt(id: string, text: string): void {
    const agent = this.requireAgent(id);
    if (agent.isStreaming) {
      throw new CoreError(`Session is already running: ${id}`, "conflict");
    }
    this.sessions.touch(id);
    void agent.prompt(text).catch(() => {
      // SessionAgent.prompt reports failures via session_error events.
    });
  }

  /** Await the prompt (CLI). Errors are reported via session_error events. */
  async prompt(id: string, text: string): Promise<void> {
    const agent = this.requireAgent(id);
    this.sessions.touch(id);
    await agent.prompt(text);
  }

  abort(id: string): void {
    this.requireAgent(id).abort();
  }

  /** Switch the model used by a session (persisted). Throws `conflict`
   * while the session is streaming (rebuilding a live agent would orphan
   * the running loop). */
  setSessionModel(id: string, provider: string, modelId: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    const model = this.models.getModel(provider, modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${provider}/${modelId}`,
        "not_found",
      );
    }
    this.assertNoStreaming([session]);
    this.sessions.updateModel(id, provider, modelId);
    this.rebuildAgent({ ...session, modelProvider: provider, modelId });
  }

  /** Rename a session (persisted). */
  setSessionName(id: string, name: string): void {
    this.sessions.rename(id, name);
  }

  /** The thinking level stored for a model (the level its sessions use). */
  getModelThinkingLevel(providerId: string, modelId: string): ThinkingLevel {
    return this.models.getThinkingLevel(providerId, modelId);
  }

  /** Set the thinking level of a model (persisted, per model). Open
   * sessions using the model are rebuilt so the change applies immediately;
   * throws `conflict` while any of them is streaming. Returns the level
   * that will actually be used (unsupported requests are clamped). */
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
    const model = this.models.getModel(providerId, modelId);
    if (!model) {
      throw new CoreError(
        `Model not found: ${providerId}/${modelId}`,
        "not_found",
      );
    }
    const affected = this.sessions.list().filter(
      (s) => s.modelProvider === providerId && s.modelId === modelId,
    );
    this.assertNoStreaming(affected);
    const effective = this.models.setThinkingLevel(providerId, modelId, level);
    for (const session of affected) {
      this.rebuildAgent(session);
    }
    return effective;
  }

  // --- model enablement ----------------------------------------------------

  /** Providers with their models; the UI and CLI use this to render pickers. */
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

  /** Local (network-free) auth check: env var or stored key resolves.
   * Used by pickers to skip unconfigured providers. */
  async hasProviderAuth(providerId: string): Promise<boolean> {
    return await this.models.hasProviderAuth(providerId);
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
    reasoning?: boolean;
    input?: string[];
    enabled: boolean;
    thinkingLevel: ThinkingLevel;
    thinkingLevels: ThinkingLevel[];
  }> {
    return this.models.getModels(providerId).map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      input: m.input,
      enabled: this.isModelEnabled(providerId, m.id),
      thinkingLevel: this.models.getThinkingLevel(providerId, m.id),
      thinkingLevels: getSupportedThinkingLevels(m),
    }));
  }

  // --- internals ----------------------------------------------------------

  private requireWorkspace(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new CoreError(`Workspace not found: ${id}`, "not_found");
    }
    return workspace;
  }

  /** Resolve workspace folders to real paths; rejects missing ones. */
  private async resolveFolders(folders: string[]): Promise<string[]> {
    const resolved: string[] = [];
    for (const folder of folders) {
      const r = await Sandbox.resolveFolder(folder);
      if (!r.ok) throw new CoreError(r.reason, "invalid");
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
      if (!model) {
        throw new CoreError(
          `Model not found: ${provider}/${modelId}`,
          "not_found",
        );
      }
      return { provider, modelId };
    }
    const latest = this.sessions.list()[0];
    if (latest && this.models.getModel(latest.modelProvider, latest.modelId)) {
      return { provider: latest.modelProvider, modelId: latest.modelId };
    }
    const fallback = this.models.getFallbackModel();
    if (fallback) return fallback;
    throw new CoreError("No models available", "unavailable");
  }

  private requireAgent(id: string): SessionAgent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new CoreError(`Session is not open: ${id}`, "not_found");
    }
    return agent;
  }

  /** Attach the session's model thinking level so the UI can render the
   * thinking control without an extra fetch. */
  private decorateSession(session: SessionInfo): SessionInfo {
    const model = this.models.getModel(
      session.modelProvider,
      session.modelId,
    );
    return {
      ...session,
      thinkingLevel: this.models.getThinkingLevel(
        session.modelProvider,
        session.modelId,
      ),
      thinkingLevels: getSupportedThinkingLevels(model),
    };
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
      throw new CoreError(
        `Model not found: ${session.modelProvider}/${session.modelId}`,
        "not_found",
      );
    }
    const { tools } = createCodingTools(workspace);
    return new SessionAgent({
      sessionId: session.id,
      systemPrompt: session.systemPrompt ?? buildSystemPrompt(workspace),
      model,
      tools,
      messages,
      thinkingLevel: this.models.getThinkingLevel(
        session.modelProvider,
        session.modelId,
      ),
      streamFn: this.models.models.streamSimple.bind(this.models.models),
      messageRepo: this.messages,
      onEvent: (event) => {
        // Remember failures for clients that do not see the WS stream;
        // a new run clears the stale error.
        if (event.type === "session_error") {
          this.lastErrors.set(event.sessionId, event.message);
        } else if (event.type === "agent_start") {
          this.lastErrors.delete(event.sessionId);
        }
        this.emit(event);
      },
    });
  }

  private rebuildAgent(session: SessionInfo): void {
    const workspace = this.requireWorkspace(session.workspaceId);
    const current = this.agents.get(session.id);
    if (current) {
      // Never replace a live agent: the old run would keep executing
      // against the same message array and duplicate DB rows (see the
      // streaming guards in updateWorkspace / setSessionModel).
      if (current.isStreaming) {
        throw new CoreError(
          `Session is already running: ${session.id}`,
          "conflict",
        );
      }
      const messages = current.messages;
      this.agents.delete(session.id);
      this.agents.set(
        session.id,
        this.buildAgent(session, workspace, messages),
      );
    }
  }

  /** Refuse configuration changes while any listed session is streaming. */
  private assertNoStreaming(sessions: SessionInfo[]): void {
    for (const session of sessions) {
      if (this.agents.get(session.id)?.isStreaming) {
        throw new CoreError(
          `Session is already running: ${session.id}`,
          "conflict",
        );
      }
    }
  }
}
