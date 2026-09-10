import type {
  AskAnswer,
  ClientEvent,
  ModePrompt,
  PendingImage,
  ThinkingLevel,
} from "./types.ts";
import { peerRouted, sessionRouted, token } from "./api-client.ts";
import { api, type SessionInfoDto } from "./api-local.ts";
import { fed } from "./api-federation.ts";
import { splitTabKey } from "./tabs.ts";

/** Per-session API routed to the peer that owns the session ("" = this
 * server). Every call targets the machine running the agent. */
export function sessionApi(key: string) {
  const { peerId, sessionId } = splitTabKey(key);
  return {
    peerId,
    sessionId,
    getSession: sessionRouted(
      peerId,
      sessionId,
      api.getSession,
      fed.getSession,
    ),
    getMessages: sessionRouted(
      peerId,
      sessionId,
      api.getMessages,
      fed.getMessages,
    ),
    getTodo: sessionRouted(peerId, sessionId, api.getTodo, fed.getTodo),
    getTasks: sessionRouted(peerId, sessionId, api.getTasks, fed.getTasks),
    getBackground: sessionRouted(
      peerId,
      sessionId,
      api.getBackground,
      fed.getBackground,
    ),
    getGoal: sessionRouted(peerId, sessionId, api.getGoal, fed.getGoal),
    cancelGoal: sessionRouted(
      peerId,
      sessionId,
      api.cancelGoal,
      fed.cancelGoal,
    ),
    close: sessionRouted(
      peerId,
      sessionId,
      api.closeSession,
      fed.closeSession,
    ),
    prompt: sessionRouted(
      peerId,
      sessionId,
      api.prompt,
      fed.prompt,
    ) as (
      text: string,
      images?: PendingImage[],
      mode?: ModePrompt,
    ) => Promise<{ ok: boolean }>,
    abort: sessionRouted(peerId, sessionId, api.abort, fed.abort),
    rewind: sessionRouted(
      peerId,
      sessionId,
      api.rewind,
      fed.rewind,
    ) as (timestamp: number) => Promise<{ ok: boolean }>,
    answer: sessionRouted(
      peerId,
      sessionId,
      api.answer,
      fed.answer,
    ) as (
      toolCallId: string,
      answers: AskAnswer[],
    ) => Promise<{ ok: boolean }>,
    updateModel: sessionRouted(
      peerId,
      sessionId,
      api.updateSessionModel,
      fed.updateSessionModel,
    ) as (provider: string, modelId: string) => Promise<SessionInfoDto>,
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
    // The model catalog endpoints (/api/providers/catalog[/refresh]) are
    // intentionally local-only: they pass through the generic federation
    // proxy (`/api/fed/:peerId/*`) so a peer can be refreshed via
    // fedRequest when needed, but the settings UI manages the catalog of
    // the server it is served from and has no peer switcher.
    catalogStatus: () => api.catalogStatus(),
    refreshCatalog: () => api.refreshCatalog(),
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
