import type { ClientEvent, ThinkingLevel } from "./types.ts";
import { peerRouted, tabCalls } from "./api-client.ts";
import { type EventStreamOptions, openEventStream } from "./event-stream.ts";
import { api, sessionRoutes } from "./api-local.ts";
import { fed } from "./api-federation.ts";
import { splitTabKey } from "./tabs.ts";

/** Per-session API routed to the peer that owns the session ("" = this
 * server). Every call targets the machine running the agent: the methods are
 * the shared session table (api-local.ts) with the tab's two ids already
 * fixed, so a tab, `api` and `fed` cannot drift apart. */
export function sessionApi(key: string) {
  const { peerId, sessionId } = splitTabKey(key);
  const { closeSession, updateSessionModel, ...sessions } = tabCalls(
    sessionRoutes,
    peerId,
    sessionId,
  );
  return {
    peerId,
    sessionId,
    ...sessions,
    // The tab's short names for the two entries that carry the session in
    // their own name: `sessionApi(key)` already named the session.
    close: closeSession,
    updateModel: updateSessionModel,
  };
}

/** Workspace CRUD + filesystem browsing of this server. A workspace is the
 * folder set of the machine the window displays, and the desktop switches
 * machines by navigating to another server (the title bar's connection
 * picker), so these calls never target a peer. */
export function workspaceApi() {
  return {
    create: (name: string, folders: string[]) =>
      api.createWorkspace(name, folders),
    update: (id: string, input: { name?: string; folders?: string[] }) =>
      api.updateWorkspace(id, input),
    delete: (id: string) => api.deleteWorkspace(id),
    fsPlaces: () => api.fsPlaces(),
    fsBrowse: (path: string) => api.fsBrowse(path),
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

/** Connect to the session event stream. Returns a close function.
 * Same origin as the page (the server serves both UI and API).
 * `onOpen` fires on every (re)connection so callers can re-sync state.
 *
 * The stream carries transport-level heartbeat frames (see
 * core/shared/heartbeat.ts): they are swallowed by the shared stream (see
 * event-stream.ts) and only refresh the liveness watchdog, so no caller ever
 * sees one. A socket that stays silent past the deadline — a link that died
 * without a close event, which is exactly what an idle stream over a
 * NAT/mobile network looks like — is closed, firing the normal `onClose`
 * path: re-sync and reconnect. */
export function connectEvents(
  onEvent: (event: ClientEvent) => void,
  onClose: () => void,
  onOpen?: () => void,
  timings: EventStreamOptions["timings"] = {},
): () => void {
  return openEventStream({ path: "/ws", timings }, onEvent, onClose, onOpen);
}
