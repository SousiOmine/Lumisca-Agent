import type { ClientEvent, ThinkingLevel } from "./types.ts";
import { WS_HEARTBEAT_TYPE } from "@lumisca/core/shared";
import { createHeartbeatWatchdog } from "./heartbeat.ts";
import { peerRouted, tabCalls, token } from "./api-client.ts";
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
    fsPlaces: peerRouted(
      peerId,
      () => api.fsPlaces(),
      (p) => fed.fsPlaces(p),
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
 * `onOpen` fires on every (re)connection so callers can re-sync state.
 *
 * The stream carries transport-level heartbeat frames (see
 * core/shared/heartbeat.ts): they are swallowed here and only refresh the
 * liveness watchdog, so no caller ever sees one. A socket that stays silent
 * past the deadline — a link that died without a close event, which is
 * exactly what an idle stream over a NAT/mobile network looks like — is
 * closed, firing the normal `onClose` path: re-sync and reconnect. */
export function connectEvents(
  onEvent: (event: ClientEvent) => void,
  onClose: () => void,
  onOpen?: () => void,
  /** Timing overrides for the watchdog (tests drive it with tiny values). */
  timings: { heartbeatTimeoutMs?: number; heartbeatCheckMs?: number } = {},
): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Browsers cannot set WS headers, so an enabled token travels in the URL.
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${proto}//${location.host}/ws${suffix}`);
  let closed = false;

  const watchdog = createHeartbeatWatchdog({
    onDead: () => {
      // Closing is the recovery: onclose re-syncs and reconnects.
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
    ...(timings.heartbeatTimeoutMs === undefined
      ? {}
      : { timeoutMs: timings.heartbeatTimeoutMs }),
    ...(timings.heartbeatCheckMs === undefined
      ? {}
      : { checkMs: timings.heartbeatCheckMs }),
  });
  // A hidden page's timers are throttled, so its silence is not evidence;
  // judge the deadline as soon as the page is visible again.
  const onVisibility = () => {
    if (!document.hidden) watchdog.check();
  };
  document.addEventListener("visibilitychange", onVisibility);

  ws.onopen = () => {
    watchdog.beat();
    onOpen?.();
  };
  ws.onmessage = (e) => {
    watchdog.beat();
    try {
      const parsed = JSON.parse(String(e.data)) as { type?: string };
      // Heartbeats are transport-level: they never reach the caller.
      if (parsed?.type === WS_HEARTBEAT_TYPE) return;
      onEvent(parsed as ClientEvent);
    } catch {
      // ignore malformed messages
    }
  };
  ws.onclose = () => {
    watchdog.stop();
    if (!closed) onClose();
  };

  return () => {
    closed = true;
    watchdog.stop();
    document.removeEventListener("visibilitychange", onVisibility);
    ws.close();
  };
}
