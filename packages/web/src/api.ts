import type {
  AgentMessage,
  ClientEvent,
  McpInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  ThinkingLevel,
  Workspace,
} from "./types.ts";

/** The SSR server serves both the UI and the API on the same origin. */
const API_BASE = "";

declare global {
  /** Embedded by the SSR server when LUMISCA_TOKEN auth is enabled. */
  var __LUMISCA_TOKEN__: string | undefined;
}

/** Optional per-instance token (embedded in the SSR page by the server).
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
    systemPrompt?: string;
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
  prompt: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
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
  setSetting: (key: string, value: string) =>
    request<{ ok: boolean }>(`/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
};

/** Connect to the WebSocket event stream. Returns a close function.
 * Same origin as the page (the SSR server serves both UI and API).
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
