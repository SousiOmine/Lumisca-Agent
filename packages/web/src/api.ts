import type {
  AgentMessage,
  AskAnswer,
  BackgroundCommandInfo,
  ClientEvent,
  ConnectionEntry,
  FederatedWorkspace,
  McpInfo,
  ModelInfo,
  PeerStatus,
  PendingImage,
  ProviderAuthType,
  ProviderInfo,
  ProviderLoginSnapshot,
  SessionInfo,
  TaskInfo,
  ThinkingLevel,
  TodoPhase,
  Workspace,
  WorkspaceFileEntry,
} from "./types.ts";
import { stripDataUrlHeader } from "@lumisca/core/shared";
import type { CommandApproval } from "@lumisca/core/shared";
import { splitTabKey } from "./tabs.ts";

/** The server serves both the UI and the API on the same origin. */
const API_BASE = "";

declare global {
  /** Embedded by the server when LUMISCA_TOKEN auth is enabled. */
  var __LUMISCA_TOKEN__: string | undefined;
}

/** Optional per-instance token (embedded in the page by the server).
 * Attached to every request; browsers cannot set WebSocket headers, so the
 * WS URL carries it as a query parameter instead. */
const token = globalThis.__LUMISCA_TOKEN__;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("x-lumisca-token", token);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body && typeof body.error === "string"
      ? body.error
      : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** Federated request: `/api/fed/:peerId*` is one generic proxy of the local
 * API surface (see server/routes/federation.ts), so any local path
 * (e.g. "/workspaces") can be addressed on a peer by adding its id. */
function fedRequest<T>(
  peerId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return request<T>(`/api/fed/${encodeURIComponent(peerId)}${path}`, init);
}

/** Bind one API call to a peer or this server: `local` runs against this
 * server (peerId === ""), `remote` against the peer. Used by the per-session
 * / workspace / model dispatchers so each method is a one-liner instead of
 * an if/else mirror. */
function peerRouted<T, A extends unknown[]>(
  peerId: string,
  local: (...args: A) => Promise<T>,
  remote: (peerId: string, ...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return (...args) => peerId === "" ? local(...args) : remote(peerId, ...args);
}

/** Session info as served by the API: includes the last run error, if any. */
export type SessionInfoDto = SessionInfo & { lastError?: string };

/** Build a prompt request body. Images are data URLs; the payload sent to
 * the agent is the base64 data without the `data:<mime>;base64,` header. */
function promptBody(text: string, images?: PendingImage[]) {
  return {
    text,
    ...(images && images.length > 0
      ? {
        images: images.map((image) => ({
          data: stripDataUrlHeader(image.data),
          mimeType: image.mimeType,
        })),
      }
      : {}),
  };
}

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
    workspaceId: string;
    name?: string;
    modelProvider?: string;
    modelId?: string;
  }) =>
    request<SessionInfo>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSession: (id: string) => request<SessionInfoDto>(`/api/sessions/${id}`),
  closeSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/close`, { method: "POST" }),
  getMessages: (id: string) =>
    request<AgentMessage[]>(`/api/sessions/${id}/messages`),
  /** The session's current todo plan (the todo tool); re-fetched after a
   * WS drop or page reload to restore the progress panel (todo events are
   * snapshots, but only mutations emit them, so they are not replayed). */
  getTodo: (id: string) =>
    request<{ todos: TodoPhase[] }>(`/api/sessions/${id}/todo`),
  /** Snapshots of the session's sub-agent tasks (the task tool); re-fetched
   * after a WS drop or page reload to restore the tasks panel (task events
   * are not replayed). */
  getTasks: (id: string) =>
    request<{ tasks: TaskInfo[] }>(`/api/sessions/${id}/tasks`),
  /** Snapshots of the session's background commands (the async_bash tool);
   * re-fetched after a WS drop or page reload to restore the background
   * panel (background events are not replayed). */
  getBackground: (id: string) =>
    request<{ backgrounds: BackgroundCommandInfo[] }>(
      `/api/sessions/${id}/background`,
    ),
  prompt: (id: string, text: string, images?: PendingImage[]) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify(promptBody(text, images)),
    }),
  abort: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  rewind: (id: string, timestamp: number) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ timestamp }),
    }),
  /** Answer a pending ask (the ask tool) with the user's selections. */
  answer: (id: string, toolCallId: string, answers: AskAnswer[]) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ toolCallId, answers }),
    }),

  listProviders: () => request<ProviderInfo[]>("/api/providers"),
  listModels: (providerId: string) =>
    request<ModelInfo[]>(`/api/providers/${providerId}/models`),
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
  updateSessionModel: (sessionId: string, provider: string, modelId: string) =>
    request<SessionInfo>(`/api/sessions/${sessionId}/model`, {
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

  /** Server-side connection registry (the federated peer list). */
  getConnections: () =>
    request<{ connections: ConnectionEntry[] }>("/api/connections"),
  putConnections: (connections: ConnectionEntry[]) =>
    request<{ ok: boolean }>("/api/connections", {
      method: "PUT",
      body: JSON.stringify({ connections }),
    }),
};

/** Federated (hub-and-spoke) API: resources owned by a peer server. The
 * agent runs on the peer; the hub only proxies. Every method here mirrors a
 * local `api.*` method through the single `/api/fed/:peerId` proxy (paths
 * are the "/api"-relative form with the peer id added by fedRequest). */
export const fed = {
  /** Merged workspace list (hub + peers) with peer reachability. */
  workspaces: () =>
    request<{ workspaces: FederatedWorkspace[]; peers: PeerStatus[] }>(
      "/api/fed/workspaces",
    ),
  createWorkspace: (peerId: string, name: string, folders: string[]) =>
    fedRequest<Workspace>(peerId, "/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, folders }),
    }),
  updateWorkspace: (
    peerId: string,
    id: string,
    input: { name?: string; folders?: string[] },
  ) =>
    fedRequest<Workspace>(peerId, `/workspaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (peerId: string, id: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/workspaces/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  fsRoots: (peerId: string) => fedRequest<string[]>(peerId, "/fs/roots"),
  fsBrowse: (peerId: string, path: string) =>
    fedRequest<
      {
        path: string;
        parent: string | null;
        entries: Array<{ name: string; path: string }>;
      }
    >(
      peerId,
      `/fs/browse?path=${encodeURIComponent(path)}`,
    ),
  workspaceFiles: (peerId: string, workspaceId: string, query: string) =>
    fedRequest<{ entries: WorkspaceFileEntry[] }>(
      peerId,
      `/workspaces/${encodeURIComponent(workspaceId)}/files?query=${
        encodeURIComponent(query)
      }`,
    ),
  createSession: (peerId: string, input: {
    workspaceId: string;
    name?: string;
  }) =>
    fedRequest<SessionInfo>(peerId, "/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSession: (peerId: string, sessionId: string) =>
    fedRequest<SessionInfoDto>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}`,
    ),
  getMessages: (peerId: string, sessionId: string) =>
    fedRequest<AgentMessage[]>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
    ),
  getTodo: (peerId: string, sessionId: string) =>
    fedRequest<{ todos: TodoPhase[] }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/todo`,
    ),
  getTasks: (peerId: string, sessionId: string) =>
    fedRequest<{ tasks: TaskInfo[] }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/tasks`,
    ),
  getBackground: (peerId: string, sessionId: string) =>
    fedRequest<{ backgrounds: BackgroundCommandInfo[] }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/background`,
    ),
  closeSession: (peerId: string, sessionId: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/close`,
      { method: "POST" },
    ),
  prompt: (
    peerId: string,
    sessionId: string,
    text: string,
    images?: PendingImage[],
  ) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { method: "POST", body: JSON.stringify(promptBody(text, images)) },
    ),
  abort: (peerId: string, sessionId: string) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
    ),
  rewind: (peerId: string, sessionId: string, timestamp: number) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/rewind`,
      { method: "POST", body: JSON.stringify({ timestamp }) },
    ),
  /** Answer a pending ask of a remote session (the agent runs on the peer;
   * the answer is forwarded to the machine holding the question). */
  answer: (
    peerId: string,
    sessionId: string,
    toolCallId: string,
    answers: AskAnswer[],
  ) =>
    fedRequest<{ ok: boolean }>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/answer`,
      { method: "POST", body: JSON.stringify({ toolCallId, answers }) },
    ),
  updateSessionModel: (
    peerId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ) =>
    fedRequest<SessionInfo>(
      peerId,
      `/sessions/${encodeURIComponent(sessionId)}/model`,
      { method: "POST", body: JSON.stringify({ provider, modelId }) },
    ),
  /** The peer's providers/models (model picker data for remote sessions). */
  listProviders: (peerId: string) =>
    fedRequest<ProviderInfo[]>(peerId, "/providers"),
  listModels: (peerId: string, providerId: string) =>
    fedRequest<ModelInfo[]>(
      peerId,
      `/providers/${encodeURIComponent(providerId)}/models`,
    ),
  setModelThinkingLevel: (
    peerId: string,
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ) =>
    fedRequest<{ ok: boolean; thinkingLevel: ThinkingLevel }>(
      peerId,
      `/providers/${encodeURIComponent(providerId)}/models/${
        encodeURIComponent(modelId)
      }/thinking-level`,
      { method: "PUT", body: JSON.stringify({ level }) },
    ),
};

/** Per-session API routed to the peer that owns the session ("" = this
 * server). Every call targets the machine running the agent. */
export function sessionApi(key: string) {
  const { peerId, sessionId } = splitTabKey(key);
  return {
    peerId,
    sessionId,
    getSession: peerRouted(
      peerId,
      () => api.getSession(sessionId),
      (p) => fed.getSession(p, sessionId),
    ),
    getMessages: peerRouted(
      peerId,
      () => api.getMessages(sessionId),
      (p) => fed.getMessages(p, sessionId),
    ),
    getTodo: peerRouted(
      peerId,
      () => api.getTodo(sessionId),
      (p) => fed.getTodo(p, sessionId),
    ),
    getTasks: peerRouted(
      peerId,
      () => api.getTasks(sessionId),
      (p) => fed.getTasks(p, sessionId),
    ),
    getBackground: peerRouted(
      peerId,
      () => api.getBackground(sessionId),
      (p) => fed.getBackground(p, sessionId),
    ),
    close: peerRouted(
      peerId,
      () => api.closeSession(sessionId),
      (p) => fed.closeSession(p, sessionId),
    ),
    prompt: peerRouted(
      peerId,
      (text: string, images?: PendingImage[]) =>
        api.prompt(sessionId, text, images),
      (p, text: string, images?: PendingImage[]) =>
        fed.prompt(p, sessionId, text, images),
    ),
    abort: peerRouted(
      peerId,
      () => api.abort(sessionId),
      (p) => fed.abort(p, sessionId),
    ),
    rewind: peerRouted(
      peerId,
      (timestamp: number) => api.rewind(sessionId, timestamp),
      (p, timestamp: number) => fed.rewind(p, sessionId, timestamp),
    ),
    answer: peerRouted(
      peerId,
      (toolCallId: string, answers: AskAnswer[]) =>
        api.answer(sessionId, toolCallId, answers),
      (p, toolCallId: string, answers: AskAnswer[]) =>
        fed.answer(p, sessionId, toolCallId, answers),
    ),
    updateModel: peerRouted(
      peerId,
      (provider: string, modelId: string) =>
        api.updateSessionModel(sessionId, provider, modelId),
      (p, provider: string, modelId: string) =>
        fed.updateSessionModel(p, sessionId, provider, modelId),
    ),
  };
}

/** Workspace CRUD + filesystem browsing routed to the peer that owns the
 * workspace ("" = this server). */
export function workspaceApi(peerId: string) {
  return {
    create: peerRouted(
      peerId,
      (name: string, folders: string[]) => api.createWorkspace(name, folders),
      (p, name: string, folders: string[]) =>
        fed.createWorkspace(p, name, folders),
    ),
    update: peerRouted(
      peerId,
      (id: string, input: { name?: string; folders?: string[] }) =>
        api.updateWorkspace(id, input),
      (p, id: string, input: { name?: string; folders?: string[] }) =>
        fed.updateWorkspace(p, id, input),
    ),
    delete: peerRouted(
      peerId,
      (id: string) => api.deleteWorkspace(id),
      (p, id: string) => fed.deleteWorkspace(p, id),
    ),
    fsRoots: peerRouted(
      peerId,
      () => api.fsRoots(),
      (p) => fed.fsRoots(p),
    ),
    fsBrowse: peerRouted(
      peerId,
      (path: string) => api.fsBrowse(path),
      (p, path: string) => fed.fsBrowse(p, path),
    ),
  };
}

/** Model-picker data of the peer that owns a session ("" = this server):
 * remote sessions switch models against the machine running the agent. */
export function modelApi(peerId: string) {
  return {
    listProviders: peerRouted(
      peerId,
      () => api.listProviders(),
      (p) => fed.listProviders(p),
    ),
    listModels: peerRouted(
      peerId,
      (providerId: string) => api.listModels(providerId),
      (p, providerId: string) => fed.listModels(p, providerId),
    ),
    setThinkingLevel: peerRouted(
      peerId,
      (providerId: string, modelId: string, level: ThinkingLevel) =>
        api.setModelThinkingLevel(providerId, modelId, level),
      (p, providerId: string, modelId: string, level: ThinkingLevel) =>
        fed.setModelThinkingLevel(p, providerId, modelId, level),
    ),
  };
}

/** Connect to the WebSocket event stream. Returns a close function.
 * Same origin as the page (the server serves both UI and API).
 * `onOpen` fires on every (re)connection so callers can re-sync state. */
export function connectEvents(
  onEvent: (event: ClientEvent) => void,
  onClose: () => void,
  onOpen?: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Browsers cannot set WS headers, so an enabled token travels in the URL.
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${proto}//${location.host}/ws${suffix}`);
  let closed = false;

  ws.onopen = () => onOpen?.();
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(String(e.data)) as ClientEvent);
    } catch {
      // ignore malformed messages
    }
  };
  ws.onclose = () => {
    if (!closed) onClose();
  };

  return () => {
    closed = true;
    ws.close();
  };
}
