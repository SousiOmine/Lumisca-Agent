import type {
  AgentMessage,
  AskAnswer,
  BackgroundCommandInfo,
  CatalogStatus,
  ConnectionEntry,
  FsBrowse,
  FsPlace,
  GoalInfo,
  McpAuthSnapshot,
  McpInfo,
  McpTestResult,
  ModelInfo,
  ModePrompt,
  PendingImage,
  PendingQuestion,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginSnapshot,
  RoutineView,
  SessionInfo,
  SkillInfo,
  StellaAgent,
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
import type { CommandApproval, SavedPrompt } from "@lumisca/core/shared";
import type { ContextUsageSummary } from "@lumisca/core/shared";
import {
  promptBody,
  request,
  sessionCalls,
  sessionPath,
  sessionRequest,
  type SessionRoute,
} from "./api-client.ts";

/** Session info as served by the API: includes the last run error, if any. */
export type SessionInfoDto = SessionInfo & { lastError?: string };

/** What GET /sessions/:id/messages serves: the session's live state that
 * the event stream cannot restore on its own. Events are never replayed, so
 * a client that (re)connects (page load, WS drop) learns the run state, the
 * pending ask questions, the last failure, and the current title only from
 * here — and the server reads every piece in one handler so they cannot
 * disagree with the transcript they travel with (see events.applyRunState
 * for `running`). */
export interface SessionSnapshot {
  /** A WINDOW of the transcript, oldest first: the newest messages on open,
   * or the ones before the `older` cursor a client asked for. A long
   * session's transcript is not sent whole (see `older`). */
  messages: AgentMessage[];
  /** The cursor for the window before `messages[0]`, or null at the
   * transcript's beginning. Opaque; echo it back to read further. */
  older: string | null;
  /** A run is active right now (its `agent_start` was never replayed). */
  running: boolean;
  /** Questions the agent is waiting on (the ask tool); empty when none is
   * pending. The run stays blocked until they are answered. */
  questions: PendingQuestion[];
  /** The last run failure, if any (cleared when a new run starts). Absent
   * when the session has not failed. */
  error?: string;
  /** The session's current title (it may have been generated after the
   * client last read the session info). */
  name: string;
  /** Context usage over the WHOLE transcript. A window cannot answer this
   * (its older turns are not loaded), and the meter would silently report
   * the window's average as the session's. */
  usage: ContextUsageSummary;
  /** The session's revision at the moment of this snapshot (see
   * `api.getRevision`): the client seeds its "everything seen up to here"
   * marker from it, so a later probe can tell whether anything was missed. */
  rev: number;
}

/** Every session-scoped endpoint, in one table: the peer id of the machine
 * that owns the session ("" = this server, see sessionRequest), the session
 * id, then the call's own args. `api` (this server), `fed` (a peer) and
 * `sessionApi` (the peer a tab routes to) are all built from it, so an
 * endpoint's path, method and body are written once. Paths are the
 * `sessionPath` form: whether they are reached as `/api/...` or through the
 * fed proxy is the transport's business, not the route's. */
export const sessionRoutes = {
  getSession: (peerId: string, sessionId: string) =>
    sessionRequest<SessionInfoDto>(peerId, sessionPath(sessionId)),
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
    const suffix = query.size === 0 ? "/messages" : `/messages?${query}`;
    return sessionRequest<SessionSnapshot>(
      peerId,
      sessionPath(sessionId, suffix),
    );
  },
  /** The session's revision: how many events the owning server has emitted
   * for it. Cheap (a counter read, no session open), so the client polls it
   * on a low interval and re-reads the snapshot only when it moved — a
   * missed frame is then noticed without re-reading anything. */
  getRevision: (peerId: string, sessionId: string) =>
    sessionRequest<{ rev: number }>(
      peerId,
      sessionPath(sessionId, "/revision"),
    ),
  /** The session's current todo plan (the todo tool); re-fetched after a
   * WS drop or page reload to restore the progress panel (todo events are
   * snapshots, but only mutations emit them, so they are not replayed). */
  getTodo: (peerId: string, sessionId: string) =>
    sessionRequest<{ todos: TodoPhase[] }>(
      peerId,
      sessionPath(sessionId, "/todo"),
    ),
  /** Snapshots of the session's sub-agent tasks (the task tool); re-fetched
   * after a WS drop or page reload to restore the tasks panel (task events
   * are not replayed). */
  getTasks: (peerId: string, sessionId: string) =>
    sessionRequest<{ tasks: TaskInfo[] }>(
      peerId,
      sessionPath(sessionId, "/tasks"),
    ),
  /** Snapshots of the session's background commands (the async_bash tool);
   * re-fetched after a WS drop or page reload to restore the background
   * panel (background events are not replayed). */
  getBackground: (peerId: string, sessionId: string) =>
    sessionRequest<{ backgrounds: BackgroundCommandInfo[] }>(
      peerId,
      sessionPath(sessionId, "/background"),
    ),
  /** The session's active goal (`/goal` mode); re-fetched after a WS drop
   * or page reload to restore the right-side goal panel (goal events are
   * not replayed). Null when no goal runs. */
  getGoal: (peerId: string, sessionId: string) =>
    sessionRequest<{ goal: GoalInfo | null }>(
      peerId,
      sessionPath(sessionId, "/goal"),
    ),
  /** Cancel the session's active goal (the goal panel's cancel button). */
  cancelGoal: (peerId: string, sessionId: string) =>
    sessionRequest<{ ok: boolean }>(peerId, sessionPath(sessionId, "/goal"), {
      method: "DELETE",
    }),
  closeSession: (peerId: string, sessionId: string) =>
    sessionRequest<{ ok: boolean }>(peerId, sessionPath(sessionId, "/close"), {
      method: "POST",
    }),
  prompt: (
    peerId: string,
    sessionId: string,
    text: string,
    images?: PendingImage[],
    mode?: ModePrompt,
  ) =>
    sessionRequest<{ ok: boolean }>(peerId, sessionPath(sessionId, "/prompt"), {
      method: "POST",
      body: JSON.stringify(promptBody(text, images, mode)),
    }),
  abort: (peerId: string, sessionId: string) =>
    sessionRequest<{ ok: boolean }>(peerId, sessionPath(sessionId, "/abort"), {
      method: "POST",
    }),
  rewind: (peerId: string, sessionId: string, timestamp: number) =>
    sessionRequest<{ ok: boolean }>(peerId, sessionPath(sessionId, "/rewind"), {
      method: "POST",
      body: JSON.stringify({ timestamp }),
    }),
  /** Condense older history into a checkpoint on demand (the `/compact`
   * command). `instructions` is the user's extra focus for the summary.
   * `compacted` is the number of summarized messages; absent when nothing
   * could be condensed. */
  compact: (peerId: string, sessionId: string, instructions?: string) =>
    sessionRequest<{ ok: boolean; compacted?: number }>(
      peerId,
      sessionPath(sessionId, "/compact"),
      {
        method: "POST",
        ...(instructions !== undefined && instructions.length > 0
          ? { body: JSON.stringify({ instructions }) }
          : {}),
      },
    ),
  /** Answer a pending ask (the ask tool) with the user's selections. */
  answer: (
    peerId: string,
    sessionId: string,
    toolCallId: string,
    answers: AskAnswer[],
  ) =>
    sessionRequest<{ ok: boolean }>(peerId, sessionPath(sessionId, "/answer"), {
      method: "POST",
      body: JSON.stringify({ toolCallId, answers }),
    }),
  /** Switch the session's model; the route answers the plain session record
   * (unlike getSession, it carries no last run error). */
  updateSessionModel: (
    peerId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ) =>
    sessionRequest<SessionInfo>(peerId, sessionPath(sessionId, "/model"), {
      method: "POST",
      body: JSON.stringify({ provider, modelId }),
    }),
} satisfies Record<string, SessionRoute>;

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
    request<{ entries: WorkspaceFileEntry[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files?query=${
        encodeURIComponent(query)
      }`,
    ),

  /** The skills a session in this workspace would see (the `/skill`
   * palette's source of truth — the same discovery the agent's skill tool
   * runs). Omitted workspaceId asks for a chat session's skills, like
   * createSession without a workspace. */
  getSkills: (workspaceId?: string) =>
    request<{ skills: SkillInfo[] }>(
      workspaceId === undefined
        ? "/api/skills"
        : `/api/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),

  getDefaultModel: () =>
    request<
      {
        provider: string;
        modelId: string;
        thinkingLevel: ThinkingLevel;
        thinkingLevels: ThinkingLevel[];
      } | null
    >(
      "/api/sessions/default-model",
    ),
  createSession: (input: {
    workspaceId?: string;
    name?: string;
    modelProvider?: string;
    modelId?: string;
  }) =>
    request<SessionInfo>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** All sessions of this server, newest first (the source of the recent
   * sessions list). stella's conversation is never in it: it is not a
   * session the user opened. */
  listSessions: () => request<SessionInfo[]>("/api/sessions"),

  // --- stella mode -------------------------------------------------------

  /** What this server can do for stella mode, and how its machine is doing.
   * The chosen mode is the client's own (hooks/useAppMode.ts), so it is not
   * read here. */
  getStellaStatus: () => request<StellaStatus>("/api/stella/status"),
  /** The agents of stella mode, most recently used first, and which
   * one a fresh screen opens. */
  getStellaAgents: () =>
    request<{ agents: StellaAgent[]; defaultAgentId: string | null }>(
      "/api/stella/agents",
    ),
  createStellaAgent: (name: string, role: string) =>
    request<StellaAgent>("/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name, role }),
    }),
  /** Set the agent's picture (`data` is a base64 image, with or without its
   * data-URL header). Answers the updated agent. */
  setStellaAgentIcon: (id: string, icon: { data: string; mimeType: string }) =>
    request<StellaAgent>(
      `/api/stella/agents/${encodeURIComponent(id)}/icon`,
      { method: "PUT", body: JSON.stringify(icon) },
    ),
  /** Drop the picture: the agent goes back to its initial. */
  clearStellaAgentIcon: (id: string) =>
    request<StellaAgent>(
      `/api/stella/agents/${encodeURIComponent(id)}/icon`,
      { method: "DELETE" },
    ),
  deleteStellaAgent: (id: string) =>
    request<{ ok: boolean }>(
      `/api/stella/agents/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** One agent's conversation, created on first use. This is also what starts
   * the machine (a first run builds its image: the call can take minutes). */
  getStellaSession: (agentId?: string) =>
    request<SessionInfo>(
      agentId === undefined
        ? "/api/stella/session"
        : `/api/stella/session?agentId=${encodeURIComponent(agentId)}`,
    ),
  /** The skills a stella session can load. */
  getStellaSkills: () => request<{ skills: SkillInfo[] }>("/api/stella/skills"),

  // --- routines (scheduled requests of a stella conversation) --------------

  /** One agent's routines, with the "running now" flag. */
  listRoutines: (agentId: string) =>
    request<{ routines: RoutineView[] }>(
      `/api/stella/agents/${encodeURIComponent(agentId)}/routines`,
    ),
  /** Turn a routine on or off (the server recomputes its next run). */
  setRoutineEnabled: (id: string, enabled: boolean) =>
    request<{ routines: RoutineView[] }>(
      `/api/routines/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    ),
  deleteRoutine: (id: string) =>
    request<{ routines: RoutineView[] }>(
      `/api/routines/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** Start a run now (the server does not wait for it to finish). */
  runRoutine: (id: string) =>
    request<{ routines: RoutineView[] }>(
      `/api/routines/${encodeURIComponent(id)}/run`,
      { method: "POST" },
    ),
  /** Stop the run this routine started. */
  stopRoutine: (id: string) =>
    request<{ routines: RoutineView[] }>(
      `/api/routines/${encodeURIComponent(id)}/stop`,
      { method: "POST" },
    ),
  listProviders: () => request<ProviderInfo[]>("/api/providers"),
  listModels: (providerId: string) =>
    request<ModelInfo[]>(`/api/providers/${providerId}/models`),
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
    request<
      {
        providerId: string;
        configured: boolean;
        source?: string;
        authType?: ProviderAuthType;
      }
    >(
      `/api/providers/${providerId}/auth`,
    ),
  setApiKey: (providerId: string, key: string) =>
    request<{ ok: boolean }>(`/api/providers/${providerId}/api-key`, {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  /** Start an OAuth login flow for a provider; returns a session id to
   * poll with providerLoginPoll. */
  providerLogin: (providerId: string) =>
    request<{ sessionId: string }>(
      `/api/providers/${providerId}/login`,
      { method: "POST" },
    ),
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
    request<{ ok: boolean }>(`/api/providers/${providerId}/logout`, {
      method: "POST",
    }),

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
  ) =>
    request<{ ok: boolean; thinkingLevel: ThinkingLevel }>(
      `/api/providers/${providerId}/models/${
        encodeURIComponent(modelId)
      }/thinking-level`,
      { method: "PUT", body: JSON.stringify({ level }) },
    ),

  /** The workspace folder picker's sidebar places (the user folders that
   * exist on this machine, then its filesystem roots). */
  fsPlaces: () => request<FsPlace[]>("/api/fs/places"),
  fsBrowse: (path: string) =>
    request<FsBrowse>(
      `/api/fs/browse?path=${encodeURIComponent(path)}`,
    ),
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
    request<McpAuthSnapshot>(
      `/api/mcp/auth/${encodeURIComponent(sessionId)}`,
    ),
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

  /** The approvals record of the command safety check (bash/eval judged by
   * the fast model). The enable toggle is a plain setting
   * (`command_safety_enabled`) read through getSettings. */
  getCommandSafety: () =>
    request<{ approvals: CommandApproval[] }>(
      "/api/settings/command-safety",
    ),
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
  updateSavedPrompt: (
    id: string,
    input: { label?: string; prompt?: string },
  ) =>
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

  /** Server-side connection registry (the federated peer list). */
  getConnections: () =>
    request<{ connections: ConnectionEntry[] }>("/api/connections"),
  putConnections: (connections: ConnectionEntry[]) =>
    request<{ ok: boolean }>("/api/connections", {
      method: "PUT",
      body: JSON.stringify({ connections }),
    }),

  /** The session-scoped endpoints (`getSession`, `prompt`, …), from the
   * table every surface shares (see sessionRoutes; "" is this server). */
  ...sessionCalls(sessionRoutes, ""),
};
