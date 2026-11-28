import type { DefaultModel } from "@lumisca/core";
import {
  type CommandApproval,
  enc,
  paths,
  type SavedPrompt,
  type SessionSnapshot,
  type SetupState,
} from "@lumisca/core/shared";
import {
  apiPathOf,
  request,
  type SessionRoute,
  sessionCalls,
  sessionRequest,
} from "./api-client.ts";
import { conversationCalls, sessionFamily } from "./api-conversation.ts";
import type {
  AgentMcpView,
  BackgroundCommandInfo,
  CatalogStatus,
  FsBrowse,
  FsPlace,
  McpAuthSnapshot,
  McpInfo,
  McpTestResult,
  ModelInfo,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginMethod,
  ProviderLoginSnapshot,
  RoutineView,
  SessionInfo,
  SkillInfo,
  StellaAgent,
  StellaAgentSummary,
  StellaMachineStatus,
  StellaStatus,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
  UserProviderInput,
  UserProviderSummary,
  WebSearchProviderForm,
  WebSearchProviderUpdate,
  WebSearchSettingsView,
  WebSearchTestView,
  Workspace,
  WorkspaceFileEntry,
} from "./types.ts";

/** Session info as served by the API: includes the last run error, if any. */
export type SessionInfoDto = SessionInfo & { lastError?: string };

/** Every session-scoped endpoint, in one table: the peer id of the machine
 * that owns the session ("" = this server, see sessionRequest), the session
 * id, then the call's own args. `api` (this server), `fed` (a peer) and
 * `sessionApi` (the peer a tab routes to) are all built from it, so an
 * endpoint's path, method and body are written once. Paths are the templates
 * of core/shared/api-paths.ts filled in: whether they are reached as
 * `/api/...` or through the fed proxy is the transport's business, not the
 * route's. */
export const sessionRoutes = {
  // Revision, prompt, abort, rewind and answer are the calls a conversation
  // shares (routes/conversation.ts); api-conversation.ts states them once for
  // both surfaces.
  ...conversationCalls(sessionFamily, sessionRequest),
  getSession: (peerId: string, sessionId: string) =>
    sessionRequest<SessionInfoDto>(
      peerId,
      apiPathOf(paths.session, { id: enc(sessionId) }),
    ),
  /** One window of the session's live-state snapshot (the transcript window
   * plus the run state, pending questions, last error, title and revision
   * that event replay cannot restore); re-fetched after a WS drop or page
   * reload to restore a tab. `window.older` asks for the history before a
   * cursor the previous response returned (see SessionSnapshot). */
  getMessages: (
    peerId: string,
    sessionId: string,
    window: { older?: string; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (window.older !== undefined) query.set("older", window.older);
    if (window.limit !== undefined) query.set("limit", String(window.limit));
    const search = query.size === 0 ? "" : `?${query}`;
    return sessionRequest<SessionSnapshot>(
      peerId,
      `${apiPathOf(paths.sessionMessages, { id: enc(sessionId) })}${search}`,
    );
  },
  /** The session's current todo plan (the todo tool); re-fetched after a
   * WS drop or page reload to restore the progress panel (todo events are
   * snapshots, but only mutations emit them, so they are not replayed). */
  getTodo: (peerId: string, sessionId: string) =>
    sessionRequest<{ todos: TodoPhase[] }>(
      peerId,
      apiPathOf(paths.sessionTodo, { id: enc(sessionId) }),
    ),
  /** Snapshots of the session's sub-agent tasks (the task tool); re-fetched
   * after a WS drop or page reload to restore the tasks panel (task events
   * are not replayed). */
  getTasks: (peerId: string, sessionId: string) =>
    sessionRequest<{ tasks: TaskInfo[] }>(
      peerId,
      apiPathOf(paths.sessionTasks, { id: enc(sessionId) }),
    ),
  /** Snapshots of the session's background commands (the async_bash tool);
   * re-fetched after a WS drop or page reload to restore the background
   * panel (background events are not replayed). */
  getBackground: (peerId: string, sessionId: string) =>
    sessionRequest<{ backgrounds: BackgroundCommandInfo[] }>(
      peerId,
      apiPathOf(paths.sessionBackground, { id: enc(sessionId) }),
    ),
  closeSession: (peerId: string, sessionId: string) =>
    sessionRequest<{ ok: boolean }>(
      peerId,
      apiPathOf(paths.sessionClose, { id: enc(sessionId) }),
      { method: "POST" },
    ),
  /** Condense older history into a checkpoint on demand (the `/compact`
   * command). `instructions` is the user's extra focus for the summary.
   * `compacted` is the number of summarized messages; absent when nothing
   * could be condensed. */
  compact: (peerId: string, sessionId: string, instructions?: string) =>
    sessionRequest<{ ok: boolean; compacted?: number }>(
      peerId,
      apiPathOf(paths.sessionCompact, { id: enc(sessionId) }),
      {
        method: "POST",
        ...(instructions !== undefined && instructions.length > 0
          ? { body: JSON.stringify({ instructions }) }
          : {}),
      },
    ),
  /** Switch the session's model; the route answers the plain session record
   * (unlike getSession, it carries no last run error). A switch made while a
   * run is in flight is stored at once and takes effect from the next run. */
  updateSessionModel: (
    peerId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ) =>
    sessionRequest<SessionInfo>(
      peerId,
      apiPathOf(paths.sessionModel, { id: enc(sessionId) }),
      { method: "POST", body: JSON.stringify({ provider, modelId }) },
    ),
} satisfies Record<string, SessionRoute>;

/** Every endpoint that exists on both this server and a peer, in one table:
 * the peer id ("" = this server, see sessionRequest), then the call's own
 * args. `api` (this server), `fed` (a peer) and `modelApi` (the peer that
 * runs a session's agent) are built from it, so the path, method and body are
 * written once. The same shape as sessionRoutes, for the calls that are not
 * about one session.
 *
 * Workspaces are NOT in here: a workspace is the folder set of the server the
 * window displays, and the desktop switches machines by navigating (the title
 * bar's connection picker) instead of addressing a peer's workspaces through
 * this one. Their paths therefore exist only in `api`. */
export const peerRoutes = {
  listProviders: (peerId: string) =>
    sessionRequest<ProviderInfo[]>(peerId, "/providers"),
  listModels: (peerId: string, providerId: string) =>
    sessionRequest<ModelInfo[]>(
      peerId,
      `/providers/${encodeURIComponent(providerId)}/models`,
    ),
  setModelThinkingLevel: (
    peerId: string,
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ) =>
    sessionRequest<{ ok: boolean; thinkingLevel: ThinkingLevel }>(
      peerId,
      `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(
        modelId,
      )}/thinking-level`,
      { method: "PUT", body: JSON.stringify({ level }) },
    ),
  workspaceFiles: (peerId: string, workspaceId: string, query: string) =>
    sessionRequest<{ entries: WorkspaceFileEntry[] }>(
      peerId,
      `/workspaces/${encodeURIComponent(workspaceId)}/files?query=${encodeURIComponent(
        query,
      )}`,
    ),
  getSkills: (peerId: string, workspaceId?: string) =>
    sessionRequest<{ skills: SkillInfo[] }>(
      peerId,
      workspaceId === undefined
        ? "/skills"
        : `/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  listSessions: (peerId: string) =>
    sessionRequest<SessionInfo[]>(peerId, paths.sessions),
} satisfies Record<
  string,
  (peerId: string, ...args: never[]) => Promise<unknown>
>;

export const api = {
  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string, folders: string[]) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, folders }),
    }),
  updateWorkspace: (id: string, input: { name?: string; folders?: string[] }) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (id: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${id}`, { method: "DELETE" }),
  /** @-mention file suggestions: the workspace tree filtered by `query`,
   * paths in the `FolderName/rel/path` form. */
  workspaceFiles: (workspaceId: string, query: string) =>
    peerRoutes.workspaceFiles("", workspaceId, query),

  /** The skills a session in this workspace would see (the `/skill`
   * palette's source of truth — the same discovery the agent's skill tool
   * runs). Omitted workspaceId asks for a chat session's skills, like
   * createSession without a workspace. */
  getSkills: (workspaceId?: string) =>
    workspaceId === undefined
      ? peerRoutes.getSkills("")
      : peerRoutes.getSkills("", workspaceId),

  getDefaultModel: () =>
    request<DefaultModel | null>(`/api${paths.sessionDefaultModel}`),
  createSession: (input: {
    workspaceId?: string;
    name?: string;
    modelProvider?: string;
    modelId?: string;
  }) =>
    request<SessionInfo>(`/api${paths.sessions}`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** All sessions of this server, newest first (the source of the recent
   * sessions list). stella's conversation is never in it: it is not a
   * session the user opened. */
  listSessions: () => peerRoutes.listSessions(""),

  // --- stella mode -------------------------------------------------------

  /** What this server can do for stella mode. The chosen mode is the
   * client's own (hooks/useAppMode.ts), so it is not read here. */
  getStellaStatus: () => request<StellaStatus>(`/api${paths.stellaStatus}`),
  /** One agent's machine: running, asleep, or being started. */
  getStellaAgentStatus: (agentId: string) =>
    request<StellaMachineStatus>(
      `/api${apiPathOf(paths.stellaAgentMachine, { id: enc(agentId) })}`,
    ),
  /** Wake one agent's machine without sending a prompt. */
  wakeStellaAgent: (agentId: string) =>
    request<{ ok: true }>(
      `/api${apiPathOf(paths.stellaAgentWake, { id: enc(agentId) })}`,
      { method: "POST" },
    ),
  /** The user did something on the machine's screen: its machine may stay
   * awake (see VM_IDLE_SLEEP_MS). */
  touchStellaAgent: (agentId: string) =>
    request<{ ok: true }>(
      `/api${apiPathOf(paths.stellaAgentTouch, { id: enc(agentId) })}`,
      { method: "POST" },
    ),
  /** The sidebar's rows of stella mode — each agent with what its
   * conversation last said. The server answers in its "most recently used"
   * order; the client orders the rows by when each conversation last spoke
   * (see compareAgentRows). Which conversation is open comes from the
   * address (`/agents/<id>`), not from this list. */
  getStellaAgents: () =>
    request<{
      agents: StellaAgentSummary[];
    }>(`/api${paths.stellaAgents}`),
  createStellaAgent: (name: string, role: string) =>
    request<StellaAgent>(`/api${paths.stellaAgents}`, {
      method: "POST",
      body: JSON.stringify({ name, role }),
    }),
  /** Change an agent's name, its picture, its model, that model's thinking
   * strength and/or whether it is switched on, in one request: the edit
   * dialog saves the first four together, and the row's menu flips `enabled`.
   * An omitted field is left alone, `icon: null` returns the agent to its
   * initial, `icon: { data, mimeType }` sets a new picture (`data` is base64,
   * with or without its data-URL header), `model: null` returns the agent to
   * the app's default model, `model: { provider, modelId }` sets its own,
   * `thinkingLevel: { provider, modelId, level }` stores the level for that
   * model (the level belongs to the model, not the agent), and `enabled`
   * switches the agent off (`false`) or back on (`true`). Answers the
   * updated agent, so the client needs no second read. */
  updateStellaAgent: (
    id: string,
    patch: {
      name?: string;
      icon?: { data: string; mimeType: string } | null;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: {
        provider: string;
        modelId: string;
        level: ThinkingLevel;
      };
      enabled?: boolean;
    },
  ) =>
    request<StellaAgent>(
      `/api${apiPathOf(paths.stellaAgent, { id: enc(id) })}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    ),
  /** The agent's own text, the identity: what the row menu's editor loads
   * before it shows anything. */
  getStellaAgentIdentity: (id: string) =>
    request<{ identity: string }>(
      `/api${apiPathOf(paths.stellaAgentIdentity, { id: enc(id) })}`,
    ),
  /** Replace the agent's own text with what the user typed. The whole text
   * travels: the editor shows the stored one and saves its field, and an
   * empty string clears the identity. Answers the updated agent. */
  setStellaAgentIdentity: (id: string, identity: string) =>
    request<StellaAgent>(
      `/api${apiPathOf(paths.stellaAgentIdentity, { id: enc(id) })}`,
      {
        method: "PUT",
        body: JSON.stringify({ identity }),
      },
    ),
  deleteStellaAgent: (id: string) =>
    request<{ ok: boolean }>(
      `/api${apiPathOf(paths.stellaAgent, { id: enc(id) })}`,
      { method: "DELETE" },
    ),
  // --- routines (scheduled requests of a stella conversation) --------------

  /** One agent's routines, with the "running now" flag. */
  listRoutines: (agentId: string) =>
    request<{ routines: RoutineView[] }>(
      `/api${apiPathOf(paths.stellaAgentRoutines, { agentId: enc(agentId) })}`,
    ),
  /** Turn a routine on or off (the server recomputes its next run). */
  setRoutineEnabled: (id: string, enabled: boolean) =>
    request<{ routines: RoutineView[] }>(
      `/api${apiPathOf(paths.routine, { id: enc(id) })}`,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    ),
  deleteRoutine: (id: string) =>
    request<{ routines: RoutineView[] }>(
      `/api${apiPathOf(paths.routine, { id: enc(id) })}`,
      { method: "DELETE" },
    ),
  /** Start a run now (the server does not wait for it to finish). */
  runRoutine: (id: string) =>
    request<{ routines: RoutineView[] }>(
      `/api${apiPathOf(paths.routineRun, { id: enc(id) })}`,
      { method: "POST" },
    ),
  /** Stop the run this routine started. */
  stopRoutine: (id: string) =>
    request<{ routines: RoutineView[] }>(
      `/api${apiPathOf(paths.routineStop, { id: enc(id) })}`,
      { method: "POST" },
    ),
  listProviders: () => peerRoutes.listProviders(""),
  listModels: (providerId: string) => peerRoutes.listModels("", providerId),
  /** Built-in model catalog status (which source is active, when it was
   * last checked). */
  catalogStatus: () =>
    request<{ status: CatalogStatus; providerCount: number }>(
      "/api/providers/catalog",
    ),
  /** Refresh the built-in model catalog from models.dev. */
  refreshCatalog: () =>
    request<{ status: CatalogStatus; providerCount: number }>(
      "/api/providers/catalog/refresh",
      { method: "POST" },
    ),
  setModelEnabled: (providerId: string, modelId: string, enabled: boolean) =>
    request<{ ok: boolean }>(
      `/api/providers/${providerId}/models/${encodeURIComponent(modelId)}`,
      { method: "PUT", body: JSON.stringify({ enabled }) },
    ),
  providerAuth: (providerId: string) =>
    request<{
      providerId: string;
      configured: boolean;
      source?: string;
      authType?: ProviderAuthType;
      account?: string;
    }>(`/api/providers/${providerId}/auth`),
  setApiKey: (providerId: string, key: string) =>
    request<{ ok: boolean }>(`/api/providers/${providerId}/api-key`, {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  /** Start an OAuth login flow; returns a session id to poll with
   * providerLoginPoll. The method is required: the two are not
   * interchangeable and the server never picks one. */
  providerLogin: (providerId: string, method: ProviderLoginMethod) =>
    request<{ sessionId: string }>(`/api/providers/${providerId}/login`, {
      method: "POST",
      body: JSON.stringify({ method }),
    }),
  providerLoginPoll: (providerId: string, sessionId: string) =>
    request<ProviderLoginSnapshot>(
      `/api/providers/${providerId}/login/${sessionId}`,
    ),
  /** Answer a prompt the flow forwarded (post back the prompt id + value). */
  providerLoginRespond: (
    providerId: string,
    sessionId: string,
    promptId: string,
    value: string,
  ) =>
    request<{ ok: boolean }>(
      `/api/providers/${providerId}/login/${sessionId}/respond`,
      { method: "POST", body: JSON.stringify({ promptId, value }) },
    ),
  providerLoginCancel: (providerId: string, sessionId: string) =>
    request<{ ok: boolean }>(
      `/api/providers/${providerId}/login/${sessionId}/cancel`,
      { method: "POST" },
    ),
  providerLogout: (providerId: string) =>
    request<{ ok: boolean; warning?: string }>(
      `/api/providers/${providerId}/logout`,
      { method: "POST" },
    ),

  /** User-defined OpenAI-compatible providers (settings UI). The API key is
   * never returned — `hasApiKey` reports whether one is set. */
  listUserProviders: () =>
    request<UserProviderSummary[]>("/api/providers/user"),
  /** Create a user-defined OpenAI-compatible provider. An `apiKey` in the
   * body is stored server-side and not echoed back. */
  createUserProvider: (input: UserProviderInput) =>
    request<UserProviderSummary>("/api/providers/user", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Update a user-defined provider; `id` matches the path. */
  updateUserProvider: (id: string, input: UserProviderInput) =>
    request<UserProviderSummary>(`/api/providers/user/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /** Remove a user-defined provider (and its stored API key). */
  deleteUserProvider: (id: string) =>
    request<{ ok: boolean }>(`/api/providers/user/${id}`, {
      method: "DELETE",
    }),
  setModelThinkingLevel: (
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ) => peerRoutes.setModelThinkingLevel("", providerId, modelId, level),

  /** The workspace folder picker's sidebar places (the user folders that
   * exist on this machine, then its filesystem roots). */
  fsPlaces: () => request<FsPlace[]>("/api/fs/places"),
  fsBrowse: (path: string) =>
    request<FsBrowse>(`/api/fs/browse?path=${encodeURIComponent(path)}`),
  /** App-level (global) MCP config; applies to every workspace. */
  getMcpConfig: () => request<McpInfo>("/api/mcp"),
  putMcpConfig: (text: string) =>
    request<McpInfo>("/api/mcp", {
      method: "PUT",
      body: text,
    }),
  /** Test one candidate server before saving it: the server connects,
   * lists its tools, and disconnects. `text` is the same single-server
   * config a PUT would store (the server reads the body as raw text). */
  testMcpServer: (text: string) =>
    request<McpTestResult>("/api/mcp/test", {
      method: "POST",
      body: text,
    }),
  /** One stella agent's MCP lists as its conversation sees them: its own
   * servers, which run inside its machine, and the shared app-level list.
   * Read-only: the agent's own tools change them. */
  getAgentMcpView: (agentId: string) =>
    request<AgentMcpView>(
      "/api/stella/agents/" + encodeURIComponent(agentId) + "/mcp",
    ),
  /** Start an OAuth sign-in for one HTTP server (the same single-server
   * config testMcpServer takes). Resolves once the flow waits for the
   * browser, so the caller can open `authorizationUrl` right away. */
  startMcpAuth: (text: string) =>
    request<McpAuthSnapshot>("/api/mcp/auth", {
      method: "POST",
      body: text,
    }),
  /** How a running sign-in is doing (the flow itself lives server-side). */
  getMcpAuth: (sessionId: string) =>
    request<McpAuthSnapshot>(`/api/mcp/auth/${encodeURIComponent(sessionId)}`),
  cancelMcpAuth: (sessionId: string) =>
    request<{ ok: boolean }>(
      `/api/mcp/auth/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST" },
    ),
  getSettings: () => request<Record<string, string>>("/api/settings"),
  setSetting: (key: string, value: string) =>
    request<{ ok: boolean }>(`/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  /** Record that the first-run setup is done (the server writes its marker
   * file beside the settings file). The answer is the state after the call;
   * the page is seeded with the same value through InitialData. */
  completeSetup: () =>
    request<SetupState>("/api/setup/complete", { method: "POST" }),

  /** The approvals record of the command safety check (bash/eval judged by
   * the fast model). The enable toggle is a plain setting
   * (`command_safety_enabled`) read through getSettings. */
  getCommandSafety: () =>
    request<{ approvals: CommandApproval[] }>("/api/settings/command-safety"),
  deleteCommandApproval: (hash: string) =>
    request<{ ok: boolean }>("/api/settings/command-safety/approvals", {
      method: "DELETE",
      body: JSON.stringify({ hash }),
    }),
  clearCommandApprovals: () =>
    request<{ ok: boolean }>("/api/settings/command-safety/approvals/all", {
      method: "DELETE",
    }),

  /** Machine-level personalization: AGENTS.md next to the settings file. */
  getPersonalization: () =>
    request<{ path: string; content: string }>("/api/personalize"),
  putPersonalization: (content: string) =>
    request<{ path: string; content: string }>("/api/personalize", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  /** Saved prompts (user-defined prompt snippets). */
  getSavedPrompts: () =>
    request<{ prompts: SavedPrompt[] }>("/api/settings/saved-prompts"),
  createSavedPrompt: (input: { id: string; label: string; prompt: string }) =>
    request<SavedPrompt>("/api/settings/saved-prompts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateSavedPrompt: (id: string, input: { label?: string; prompt?: string }) =>
    request<SavedPrompt>(
      `/api/settings/saved-prompts/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    ),
  deleteSavedPrompt: (id: string) =>
    request<{ ok: boolean }>(
      `/api/settings/saved-prompts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  /** Web search: which provider the agent uses and its stored key. The key
   * itself is never sent back; a mutation answers with the whole setting. */
  getWebSearchSettings: () => request<WebSearchSettingsView>("/api/web-search"),
  addWebSearchProvider: (form: WebSearchProviderForm) =>
    request<WebSearchSettingsView>("/api/web-search/providers", {
      method: "POST",
      body: JSON.stringify(form),
    }),
  updateWebSearchProvider: (id: string, form: WebSearchProviderUpdate) =>
    request<WebSearchSettingsView>(
      `/api/web-search/providers/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(form) },
    ),
  deleteWebSearchProvider: (id: string) =>
    request<WebSearchSettingsView>(
      `/api/web-search/providers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  setDefaultWebSearchProvider: (id: string | null) =>
    request<WebSearchSettingsView>("/api/web-search/default", {
      method: "PUT",
      body: JSON.stringify({ id }),
    }),
  testWebSearchProvider: (form: WebSearchProviderForm) =>
    request<WebSearchTestView>("/api/web-search/test", {
      method: "POST",
      body: JSON.stringify(form),
    }),

  /** The session-scoped endpoints (`getSession`, `prompt`, …), from the
   * table every surface shares (see sessionRoutes; "" is this server). */
  ...sessionCalls(sessionRoutes, ""),
};
