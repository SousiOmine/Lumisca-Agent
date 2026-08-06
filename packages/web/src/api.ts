import type {
  AgentMessage,
  ClientEvent,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  Workspace,
} from "./types.ts";

/** The SSR server serves both the UI and the API on the same origin. */
const API_BASE = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body && typeof body.error === "string"
      ? body.error
      : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),

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

  listSessions: (workspaceId?: string) =>
    request<SessionInfo[]>(
      `/api/sessions${workspaceId ? `?workspaceId=${workspaceId}` : ""}`,
    ),
  getDefaultModel: () =>
    request<{ provider: string; modelId: string } | null>(
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
  openSession: (id: string) =>
    request<SessionInfo>(`/api/sessions/${id}/open`, { method: "POST" }),
  closeSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/close`, { method: "POST" }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  getMessages: (id: string) =>
    request<AgentMessage[]>(`/api/sessions/${id}/messages`),
  prompt: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  steer: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/steer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  followUp: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/follow-up`, {
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
  setSetting: (key: string, value: string) =>
    request<{ ok: boolean }>(`/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
};

/** Connect to the WebSocket event stream. Returns a close function.
 * Same origin as the page (the SSR server serves both UI and API). */
export function connectEvents(
  onEvent: (event: ClientEvent) => void,
  onClose: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  let closed = false;

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
