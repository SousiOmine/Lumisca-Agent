import type {
  AgentMessage,
  AskAnswer,
  BackgroundCommandInfo,
  CatalogStatus,
  ConnectionEntry,
  GoalInfo,
  McpInfo,
  ModelInfo,
  ModePrompt,
  PendingImage,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginSnapshot,
  SessionInfo,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
  UserProviderInput,
  UserProviderSummary,
  Workspace,
  WorkspaceFileEntry,
} from "./types.ts";
import type { CommandApproval, SavedPrompt } from "@lumisca/core/shared";
import { promptBody, request, sessionPath } from "./api-client.ts";

/** Session info as served by the API: includes the last run error, if any. */
export type SessionInfoDto = SessionInfo & { lastError?: string };

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
  getSession: (id: string) => request<SessionInfoDto>(`/api${sessionPath(id)}`),
  /** All sessions of this server, newest first (the source of the recent
   * sessions list). */
  listSessions: () => request<SessionInfo[]>("/api/sessions"),
  closeSession: (id: string) =>
    request<{ ok: boolean }>(`/api${sessionPath(id, "/close")}`, {
      method: "POST",
    }),
  getMessages: (id: string) =>
    request<AgentMessage[]>(`/api${sessionPath(id, "/messages")}`),
  /** The session's current todo plan (the todo tool); re-fetched after a
   * WS drop or page reload to restore the progress panel (todo events are
   * snapshots, but only mutations emit them, so they are not replayed). */
  getTodo: (id: string) =>
    request<{ todos: TodoPhase[] }>(`/api${sessionPath(id, "/todo")}`),
  /** Snapshots of the session's sub-agent tasks (the task tool); re-fetched
   * after a WS drop or page reload to restore the tasks panel (task events
   * are not replayed). */
  getTasks: (id: string) =>
    request<{ tasks: TaskInfo[] }>(`/api${sessionPath(id, "/tasks")}`),
  /** Snapshots of the session's background commands (the async_bash tool);
   * re-fetched after a WS drop or page reload to restore the background
   * panel (background events are not replayed). */
  getBackground: (id: string) =>
    request<{ backgrounds: BackgroundCommandInfo[] }>(
      `/api${sessionPath(id, "/background")}`,
    ),
  /** The session's active goal (`/goal` mode); re-fetched after a WS drop
   * or page reload to restore the right-side goal panel (goal events are
   * not replayed). Null when no goal runs. */
  getGoal: (id: string) =>
    request<{ goal: GoalInfo | null }>(`/api${sessionPath(id, "/goal")}`),
  /** Cancel the session's active goal (the goal panel's cancel button). */
  cancelGoal: (id: string) =>
    request<{ ok: boolean }>(`/api${sessionPath(id, "/goal")}`, {
      method: "DELETE",
    }),
  prompt: (
    id: string,
    text: string,
    images?: PendingImage[],
    mode?: ModePrompt,
  ) =>
    request<{ ok: boolean }>(`/api${sessionPath(id, "/prompt")}`, {
      method: "POST",
      body: JSON.stringify(promptBody(text, images, mode)),
    }),
  abort: (id: string) =>
    request<{ ok: boolean }>(`/api${sessionPath(id, "/abort")}`, {
      method: "POST",
    }),
  rewind: (id: string, timestamp: number) =>
    request<{ ok: boolean }>(`/api${sessionPath(id, "/rewind")}`, {
      method: "POST",
      body: JSON.stringify({ timestamp }),
    }),
  /** Answer a pending ask (the ask tool) with the user's selections. */
  answer: (id: string, toolCallId: string, answers: AskAnswer[]) =>
    request<{ ok: boolean }>(`/api${sessionPath(id, "/answer")}`, {
      method: "POST",
      body: JSON.stringify({ toolCallId, answers }),
    }),

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
  updateSessionModel: (sessionId: string, provider: string, modelId: string) =>
    request<SessionInfo>(`/api${sessionPath(sessionId, "/model")}`, {
      method: "POST",
      body: JSON.stringify({ provider, modelId }),
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

  fsRoots: () => request<string[]>("/api/fs/roots"),
  fsBrowse: (path: string) =>
    request<
      {
        path: string;
        parent: string | null;
        entries: Array<{ name: string; path: string }>;
      }
    >(
      `/api/fs/browse?path=${encodeURIComponent(path)}`,
    ),
  /** App-level (global) MCP config; applies to every workspace. */
  getMcpConfig: () => request<McpInfo>("/api/mcp"),
  putMcpConfig: (text: string) =>
    request<McpInfo>("/api/mcp", {
      method: "PUT",
      body: text,
    }),
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

  /** Server-side connection registry (the federated peer list). */
  getConnections: () =>
    request<{ connections: ConnectionEntry[] }>("/api/connections"),
  putConnections: (connections: ConnectionEntry[]) =>
    request<{ ok: boolean }>("/api/connections", {
      method: "PUT",
      body: JSON.stringify({ connections }),
    }),
};
