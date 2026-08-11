import type {
  AgentMessage,
  ClientEvent,
  ConnectionEntry,
  FederatedWorkspace,
  McpInfo,
  ModelInfo,
  PeerStatus,
  PendingImage,
  ProviderInfo,
  SessionInfo,
  ThinkingLevel,
  Workspace,
  WorkspaceFileEntry,
} from "./types.ts";
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
          data: image.data.startsWith("data:")
            ? image.data.slice(image.data.indexOf(",") + 1)
            : image.data,
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
  openSession: (id: string) =>
    request<SessionInfoDto>(`/api/sessions/${id}/open`, { method: "POST" }),
  closeSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/close`, { method: "POST" }),
  getMessages: (id: string) =>
    request<AgentMessage[]>(`/api/sessions/${id}/messages`),
  prompt: (id: string, text: string, images?: PendingImage[]) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify(promptBody(text, images)),
    }),
  abort: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/abort`, { method: "POST" }),

  listProviders: () => request<ProviderInfo[]>("/api/providers"),
  listModels: (providerId: string) =>
    request<ModelInfo[]>(`/api/providers/${providerId}/models`),
  setModelEnabled: (providerId: string, modelId: string, enabled: boolean) =>
    request<{ ok: boolean }>(
      `/api/providers/${providerId}/models/${encodeURIComponent(modelId)}`,
      { method: "PUT", body: JSON.stringify({ enabled }) },
    ),
  providerAuth: (providerId: string) =>
    request<{ providerId: string; configured: boolean; source?: string }>(
      `/api/providers/${providerId}/auth`,
    ),
  setApiKey: (providerId: string, key: string) =>
    request<{ ok: boolean }>(`/api/providers/${providerId}/api-key`, {
      method: "POST",
      body: JSON.stringify({ key }),
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
 * agent runs on the peer; the hub only proxies. */
export const fed = {
  /** Merged workspace list (hub + peers) with peer reachability. */
  workspaces: () =>
    request<{ workspaces: FederatedWorkspace[]; peers: PeerStatus[] }>(
      "/api/fed/workspaces",
    ),
  createWorkspace: (peerId: string, name: string, folders: string[]) =>
    request<Workspace>(`/api/fed/${peerId}/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name, folders }),
    }),
  updateWorkspace: (
    peerId: string,
    id: string,
    input: { name?: string; folders?: string[] },
  ) =>
    request<Workspace>(`/api/fed/${peerId}/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteWorkspace: (peerId: string, id: string) =>
    request<{ ok: boolean }>(`/api/fed/${peerId}/workspaces/${id}`, {
      method: "DELETE",
    }),
  fsRoots: (peerId: string) => request<string[]>(`/api/fed/${peerId}/fs/roots`),
  fsBrowse: (peerId: string, path: string) =>
    request<
      {
        path: string;
        parent: string | null;
        entries: Array<{ name: string; path: string }>;
      }
    >(
      `/api/fed/${peerId}/fs/browse?path=${encodeURIComponent(path)}`,
    ),
  workspaceFiles: (peerId: string, workspaceId: string, query: string) =>
    request<{ entries: WorkspaceFileEntry[] }>(
      `/api/fed/${peerId}/workspaces/${
        encodeURIComponent(workspaceId)
      }/files?query=${encodeURIComponent(query)}`,
    ),
  createSession: (peerId: string, input: {
    workspaceId: string;
    name?: string;
  }) =>
    request<SessionInfo>(`/api/fed/${peerId}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSession: (peerId: string, sessionId: string) =>
    request<SessionInfoDto>(`/api/fed/${peerId}/sessions/${sessionId}`),
  getMessages: (peerId: string, sessionId: string) =>
    request<AgentMessage[]>(
      `/api/fed/${peerId}/sessions/${sessionId}/messages`,
    ),
  closeSession: (peerId: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/fed/${peerId}/sessions/${sessionId}/close`, {
      method: "POST",
    }),
  openSession: (peerId: string, sessionId: string) =>
    request<SessionInfoDto>(`/api/fed/${peerId}/sessions/${sessionId}/open`, {
      method: "POST",
    }),
  prompt: (
    peerId: string,
    sessionId: string,
    text: string,
    images?: PendingImage[],
  ) =>
    request<{ ok: boolean }>(
      `/api/fed/${peerId}/sessions/${sessionId}/prompt`,
      {
        method: "POST",
        body: JSON.stringify(promptBody(text, images)),
      },
    ),
  abort: (peerId: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/fed/${peerId}/sessions/${sessionId}/abort`, {
      method: "POST",
    }),
  updateSessionModel: (
    peerId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ) =>
    request<SessionInfo>(`/api/fed/${peerId}/sessions/${sessionId}/model`, {
      method: "POST",
      body: JSON.stringify({ provider, modelId }),
    }),
  /** The peer's providers/models (model picker data for remote sessions). */
  listProviders: (peerId: string) =>
    request<ProviderInfo[]>(`/api/fed/${peerId}/providers`),
  listModels: (peerId: string, providerId: string) =>
    request<ModelInfo[]>(
      `/api/fed/${peerId}/providers/${encodeURIComponent(providerId)}/models`,
    ),
  setModelThinkingLevel: (
    peerId: string,
    providerId: string,
    modelId: string,
    level: ThinkingLevel,
  ) =>
    request<{ ok: boolean; thinkingLevel: ThinkingLevel }>(
      `/api/fed/${peerId}/providers/${encodeURIComponent(providerId)}/models/${
        encodeURIComponent(modelId)
      }/thinking-level`,
      { method: "PUT", body: JSON.stringify({ level }) },
    ),
};

/** Per-session API routed to the peer that owns the session ("" = this
 * server). Every call targets the machine running the agent. */
export function sessionApi(key: string) {
  const { peerId, sessionId } = splitTabKey(key);
  if (peerId === "") {
    return {
      peerId,
      sessionId,
      getSession: () => api.getSession(sessionId),
      getMessages: () => api.getMessages(sessionId),
      close: () => api.closeSession(sessionId),
      prompt: (text: string, images?: PendingImage[]) =>
        api.prompt(sessionId, text, images),
      abort: () => api.abort(sessionId),
      updateModel: (provider: string, modelId: string) =>
        api.updateSessionModel(sessionId, provider, modelId),
    };
  }
  return {
    peerId,
    sessionId,
    getSession: () => fed.getSession(peerId, sessionId),
    getMessages: () => fed.getMessages(peerId, sessionId),
    close: () => fed.closeSession(peerId, sessionId),
    prompt: (text: string, images?: PendingImage[]) =>
      fed.prompt(peerId, sessionId, text, images),
    abort: () => fed.abort(peerId, sessionId),
    updateModel: (provider: string, modelId: string) =>
      fed.updateSessionModel(peerId, sessionId, provider, modelId),
  };
}

/** Workspace CRUD + filesystem browsing routed to the peer that owns the
 * workspace ("" = this server). */
export function workspaceApi(peerId: string) {
  if (peerId === "") {
    return {
      create: (name: string, folders: string[]) =>
        api.createWorkspace(name, folders),
      update: (id: string, input: { name?: string; folders?: string[] }) =>
        api.updateWorkspace(id, input),
      delete: (id: string) => api.deleteWorkspace(id),
      fsRoots: () => api.fsRoots(),
      fsBrowse: (path: string) => api.fsBrowse(path),
    };
  }
  return {
    create: (name: string, folders: string[]) =>
      fed.createWorkspace(peerId, name, folders),
    update: (id: string, input: { name?: string; folders?: string[] }) =>
      fed.updateWorkspace(peerId, id, input),
    delete: (id: string) => fed.deleteWorkspace(peerId, id),
    fsRoots: () => fed.fsRoots(peerId),
    fsBrowse: (path: string) => fed.fsBrowse(peerId, path),
  };
}

/** Model-picker data of the peer that owns a session ("" = this server):
 * remote sessions switch models against the machine running the agent. */
export function modelApi(peerId: string) {
  if (peerId === "") {
    return {
      listProviders: () => api.listProviders(),
      listModels: (providerId: string) => api.listModels(providerId),
      setThinkingLevel: (
        providerId: string,
        modelId: string,
        level: ThinkingLevel,
      ) => api.setModelThinkingLevel(providerId, modelId, level),
    };
  }
  return {
    listProviders: () => fed.listProviders(peerId),
    listModels: (providerId: string) => fed.listModels(peerId, providerId),
    setThinkingLevel: (
      providerId: string,
      modelId: string,
      level: ThinkingLevel,
    ) => fed.setModelThinkingLevel(peerId, providerId, modelId, level),
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
