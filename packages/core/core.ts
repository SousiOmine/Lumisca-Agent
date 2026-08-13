import { LumiscaDb } from "./db/mod.ts";
import { dirname, join } from "node:path";
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
  CONNECTIONS_KEY,
  parseConnections,
} from "./settings/connections.ts";
import {
  createDbCredentialStore,
  CREDENTIAL_KEY_PREFIX,
  setApiKey,
} from "./settings/credentials.ts";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import type {
  Api,
  AuthCheck,
  ImageContent,
  Model,
} from "@earendil-works/pi-ai";
import { createDbModelsStore, ModelManager } from "./models/mod.ts";
import {
  getSupportedThinkingLevels,
  isThinkingLevel,
} from "./models/thinking.ts";
import type { ThinkingLevel } from "./shared.ts";
import type { AskAnswer } from "./shared.ts";
import type { TaskInfo, TodoPhase } from "./shared.ts";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  parseModelPreference,
} from "./shared.ts";
import { createWorkspaceRepo, type WorkspaceRepo } from "./workspace/repo.ts";
import { Sandbox } from "./workspace/sandbox.ts";
import { createSessionRepo, type SessionRepo } from "./session/repo.ts";
import { createMessageRepo, type MessageRepo } from "./session/messages.ts";
import type { SessionAgent } from "./agent/session-agent.ts";
import { SessionPool } from "./agent/pool.ts";
import { buildSystemPrompt } from "./tools/mod.ts";
import { CoreError } from "./errors.ts";
import { APP_MCP_SETTINGS_KEY } from "./mcp/config.ts";
import type { McpInfo } from "./mcp/config.ts";
import { McpService } from "./mcp/service.ts";

export interface CreateSessionInput {
  workspaceId: string;
  name?: string;
  /** Omitted → the last-used model (or the first enabled model) is used. */
  modelProvider?: string;
  modelId?: string;
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
  private readonly pool: SessionPool;
  private readonly mcp: McpService;
  private readonly listeners = new Set<(event: ClientEvent) => void>();

  private constructor(db: LumiscaDb, settings: SettingsRepo) {
    this.db = db;
    this.settings = settings;
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
    this.pool = new SessionPool({
      getModel: (provider, modelId) => this.models.getModel(provider, modelId),
      getImageAnalysisModel: () => this.getImageAnalysisModel(),
      getFastModel: () => this.getFastModel(),
      getFastModelInfo: () => this.getFastModelInfo(),
      renameSession: (id, name) => this.setSessionName(id, name),
      getThinkingLevel: (provider, modelId) =>
        this.models.getThinkingLevel(provider, modelId),
      buildGeneratedPrompt: (workspace, model) =>
        this.buildGeneratedPrompt(workspace, model),
      updateSystemPrompt: (id, systemPrompt) =>
        this.sessions.updateSystemPrompt(id, systemPrompt),
      streamFn: this.models.models.streamSimple.bind(this.models.models),
      messageRepo: this.messages,
      // Resolved lazily (open) so the circular wiring stays one-way:
      // the pool references the service, the service references the pool
      // via the injected applySessionChange / agentMcpStatus below.
      loadMergedMcp: (workspace) => this.mcp.loadMergedConfig(workspace),
      requireWorkspace: (id) => this.requireWorkspace(id),
      emit: (event) => this.emit(event),
    });
    this.mcp = new McpService({
      settings: this.settings,
      listSessions: (workspaceId) => this.sessions.list(workspaceId),
      agentMcpStatus: (sessionId) =>
        this.pool.get(sessionId)?.getMcpStatus() ?? null,
      requireWorkspace: (id) => this.requireWorkspace(id),
      applySessionChange: (sessions, mutate) =>
        this.pool.applyChange(sessions, mutate),
    });
  }

  /** Settings live in ~/.config/lumisca-agent/settings.jsonc by default
   * (see resolveSettingsPath); an explicit settingsPath overrides that. */
  static open(
    dbPath: string,
    settingsPath: string = resolveSettingsPath(),
  ): LumiscaCore {
    return new LumiscaCore(
      LumiscaDb.open(dbPath),
      createFileSettingsRepo(settingsPath),
    );
  }

  static openInMemory(): LumiscaCore {
    return new LumiscaCore(
      LumiscaDb.openInMemory(),
      createInMemorySettingsRepo(),
    );
  }

  /** Test-only: in-memory core with extra providers (e.g. the faux provider). */
  static forTesting(extraProviders: Provider[] = []): LumiscaCore {
    const core = new LumiscaCore(
      LumiscaDb.openInMemory(),
      createInMemorySettingsRepo(),
    );
    for (const provider of extraProviders) {
      core.models.models.setProvider(provider);
    }
    return core;
  }

  close(): void {
    this.pool.closeAll();
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

  /** Read a setting. Protected keys (credentials, MCP config) are refused —
   * they have their own APIs and must never be readable through the generic
   * settings surface. */
  getSetting(key: string): string | undefined {
    this.assertNotProtected(key);
    return this.settings.get(key);
  }

  setSetting(key: string, value: string): void {
    this.assertNotProtected(key);
    this.settings.set(key, value);
  }

  deleteSetting(key: string): void {
    this.assertNotProtected(key);
    this.settings.delete(key);
  }

  // --- server connection registry (web clients) ---------------------------
  // The desktop app keeps its own per-PC copy (servers.json); web clients
  // share this server-side list so they can switch servers too.

  getConnections(): ConnectionEntry[] {
    return parseConnections(this.settings.get(CONNECTIONS_KEY));
  }

  setConnections(entries: ConnectionEntry[]): void {
    this.settings.set(CONNECTIONS_KEY, JSON.stringify(entries));
  }

  /** The protected-key category of a settings key, or undefined when the
   * key is safe to expose through the generic settings surface. Credentials
   * have their own API (/providers/:id/api-key), the app MCP config its own
   * (/api/mcp), and the connection registry its own (/api/connections);
   * touching any of them through the generic settings surface would bypass
   * those APIs. Single source of truth for both the read/write guard and
   * the listSettings filter. */
  private protectedKeyReason(key: string): string | undefined {
    if (key.startsWith(CREDENTIAL_KEY_PREFIX)) {
      return "credentials cannot be accessed through this endpoint";
    }
    if (key === APP_MCP_SETTINGS_KEY) {
      // The app MCP config may contain secrets (env vars, headers).
      return "MCP configuration cannot be accessed through this endpoint";
    }
    if (key === CONNECTIONS_KEY) {
      // The connection registry contains server tokens.
      return "connection registry cannot be accessed through this endpoint";
    }
    return undefined;
  }

  private assertNotProtected(key: string): void {
    const reason = this.protectedKeyReason(key);
    if (reason !== undefined) {
      throw new CoreError(reason, "forbidden");
    }
  }

  /** Non-protected settings only; credentials and MCP config are never
   * exposed through the generic settings surface. */
  listSettings(): Map<string, string> {
    const safe = new Map<string, string>();
    for (const [key, value] of this.settings.list()) {
      if (this.protectedKeyReason(key) !== undefined) continue;
      safe.set(key, value);
    }
    return safe;
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    await setApiKey(this.credentials, providerId, key);
  }

  // --- personalization (machine-level AGENTS.md) --------------------------

  /** The machine-level AGENTS.md (next to the settings file) with the path
   * it lives at. Absent file → empty content. */
  getPersonalization(): { path: string; content: string } {
    const path = this.personalizationPath();
    return {
      path: path ?? "",
      content: this.loadPersonalInstructions() ?? "",
    };
  }

  /** Replace the machine-level AGENTS.md. Applies to sessions created from
   * now on; existing sessions keep their snapshot. */
  setPersonalization(content: string): void {
    const path = this.personalizationPath();
    if (path === undefined) {
      throw new CoreError("No settings directory", "unavailable");
    }
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, content, { mode: 0o600 });
  }

  /** The path of the machine-level AGENTS.md, or undefined when the core
   * has no settings directory (in-memory repos). */
  private personalizationPath(): string | undefined {
    const dir = this.settings.dir();
    return dir === undefined ? undefined : join(dir, "AGENTS.md");
  }

  /** Personal instructions to append to generated system prompts. Reads the
   * machine-level AGENTS.md next to the settings file (absent → undefined). */
  private loadPersonalInstructions(): string | undefined {
    const path = this.personalizationPath();
    if (path === undefined) return undefined;
    try {
      return Deno.readTextFileSync(path);
    } catch {
      return undefined;
    }
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
    this.pool.applyChange(sessions, () => {
      this.workspaces.update(id, name, folders);
    });
    return this.workspaces.get(id)!;
  }

  deleteWorkspace(id: string): void {
    for (const session of this.sessions.list(id)) {
      this.pool.delete(session.id);
    }
    this.workspaces.delete(id);
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

  // --- sessions -----------------------------------------------------------

  /** The configured image-analysis model (the `model_image` setting), or
   * undefined when unset or the model is no longer in the catalog. It
   * interprets images as text for sessions whose main model cannot see
   * them (see agent/image-analysis.ts). */
  getImageAnalysisModel(): Model<Api> | undefined {
    const pref = parseModelPreference(this.settings.get(IMAGE_MODEL_KEY));
    if (pref === undefined) return undefined;
    return this.models.getModel(pref.provider, pref.modelId);
  }

  /** The configured fast model (the `model_fast` setting), or undefined
   * when unset or the model is no longer in the catalog. It generates
   * session titles from the first user message (see agent/title-generation.ts). */
  getFastModel(): Model<Api> | undefined {
    return this.getFastModelInfo()?.model;
  }

  /** The configured fast model with its provider/model ids, or undefined
   * when unset or the model is no longer in the catalog. Sub-agents (the
   * task tool) run on this model, with its stored thinking level. */
  getFastModelInfo():
    | { provider: string; modelId: string; model: Model<Api> }
    | undefined {
    const pref = parseModelPreference(this.settings.get(FAST_MODEL_KEY));
    if (pref === undefined) return undefined;
    const model = this.models.getModel(pref.provider, pref.modelId);
    if (model === undefined) return undefined;
    return { provider: pref.provider, modelId: pref.modelId, model };
  }

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
    // Generated prompts are snapshotted here, at creation time (workspace
    // AGENTS.md + environment + personalization included), and stored with
    // the session: later edits to either AGENTS.md must not affect it.
    const systemPrompt = this.buildGeneratedPrompt(workspace, model);
    const session = this.sessions.create({
      workspaceId: workspace.id,
      name: input.name ?? `Session ${new Date().toLocaleString()}`,
      modelProvider: model.provider,
      modelId: model.modelId,
      systemPrompt,
    });
    this.pool.open(session, workspace, []);
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
    if (!this.pool.get(id)) {
      const workspace = this.requireWorkspace(session.workspaceId);
      const messages = this.messages.listMessages(id);
      this.pool.open(session, workspace, messages);
    }
    return this.decorateSession(session);
  }

  closeSession(id: string): void {
    this.pool.close(id);
  }

  deleteSession(id: string): void {
    this.pool.delete(id);
    this.sessions.delete(id);
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
   * (processed at the next turn boundary) instead of being refused. */
  startPrompt(id: string, text: string, images?: ImageContent[]): void {
    const agent = this.pool.require(id);
    this.sessions.touch(id);
    agent.promptWhileRunning(text, images);
  }

  /** Await the prompt (CLI). Errors are reported via session_error events. */
  async prompt(
    id: string,
    text: string,
    images?: ImageContent[],
  ): Promise<void> {
    const agent = this.pool.require(id);
    this.sessions.touch(id);
    await agent.prompt(text, images);
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
    let effective: ThinkingLevel = "off";
    this.pool.applyChange(affected, () => {
      effective = this.models.setThinkingLevel(providerId, modelId, level);
    });
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

  /** The full generated system prompt for a workspace: base prompt +
   * environment section + project memory (workspace AGENTS.md) +
   * personalization (machine AGENTS.md, appended last). `model` fills in
   * the environment section's model line. */
  private buildGeneratedPrompt(
    workspace: Workspace,
    model?: { provider: string; modelId: string },
  ): string {
    const resolved = model
      ? {
        ...model,
        name: this.models.getModel(model.provider, model.modelId)?.name,
      }
      : undefined;
    return buildSystemPrompt(
      workspace,
      this.loadPersonalInstructions(),
      resolved,
    );
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
    return this.pool.require(id);
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
}
