import type { ModePrompt, PendingImage } from "./types.ts";
import { stripDataUrlHeader } from "@lumisca/core/shared";

/** The server serves both the UI and the API on the same origin. */
const API_BASE = "";

declare global {
  /** Embedded by the server when LUMISCA_TOKEN auth is enabled. */
  var __LUMISCA_TOKEN__: string | undefined;
}

/** Optional per-instance token (embedded in the page by the server).
 * Attached to every request; browsers cannot set WebSocket headers, so the
 * WS URL carries it as a query parameter instead. */
export const token = globalThis.__LUMISCA_TOKEN__;

export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("x-lumisca-token", token);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (error) {
    // Network-level failure (server down, not an HTTP error): tell the
    // desktop health monitor so its banner can classify (crashed vs hung)
    // and offer restart + log copy-paste. Plain browsers have no monitor
    // (no shell), so the dispatch is a no-op there.
    notifyServerFailure();
    throw error;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body && typeof body.error === "string"
      ? body.error
      : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** Client-side server-failure listeners (the desktop health monitor
 * registers one; see hooks/useServerHealth.ts). Dispatched on
 * network-level fetch failures only — HTTP errors (4xx/5xx) mean the
 * server answered, so they are not outages. */
type ServerFailureListener = () => void;
const serverFailureListeners = new Set<ServerFailureListener>();

/** Register a server-failure listener; returns an unsubscribe function. */
export function onServerFailure(listener: ServerFailureListener): () => void {
  serverFailureListeners.add(listener);
  return () => serverFailureListeners.delete(listener);
}

function notifyServerFailure(): void {
  for (const listener of [...serverFailureListeners]) {
    try {
      listener();
    } catch {
      // A monitor must never break the API call that reported to it.
    }
  }
}

/** Federated request: `/api/fed/:peerId*` is one generic proxy of the local
 * API surface (see server/routes/federation.ts), so any local path
 * (e.g. "/workspaces") can be addressed on a peer by adding its id. */
export function fedRequest<T>(
  peerId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return request<T>(`/api/fed/${encodeURIComponent(peerId)}${path}`, init);
}

/** `/sessions/:id/...` path builder (single home for the segment every
 * federated session call repeats). */
export function sessionPath(sessionId: string, suffix = ""): string {
  return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

/** URL base of a session's visual assets (`visual:` image references in its
 * messages resolve against it, always ending with "/"). The machine running
 * the agent owns the assets, so a peer's session is read through the hub's
 * federation proxy: the peer's route under the `/api/fed/<peerId>` prefix —
 * the same shape as every other federated call. */
export function sessionVisualBase(peerId: string, sessionId: string): string {
  const path = `${sessionPath(sessionId, "/visual/")}`;
  return peerId === ""
    ? `/api${path}`
    : `/api/fed/${encodeURIComponent(peerId)}${path}`;
}

/** Bind one API call to a peer or this server: `local` runs against this
 * server (peerId === ""), `remote` against the peer. Used by the per-session
 * / workspace / model dispatchers so each method is a one-liner instead of
 * an if/else mirror. */
export function peerRouted<T, A extends unknown[]>(
  peerId: string,
  local: (...args: A) => Promise<T>,
  remote: (peerId: string, ...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return (...args) => peerId === "" ? local(...args) : remote(peerId, ...args);
}

/** Send one session-scoped request to the machine that owns the session:
 * `""` is this server — the empty peer id `peerRouted` and the tab keys use
 * for it — whose routes are served under `/api`; any other id goes through
 * the hub's fed proxy. The session route table (see api-local.ts) is the one
 * definition of those routes, so which path addresses the machine lives in
 * the transport all three surfaces share. */
export function sessionRequest<T>(
  peerId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return peerId === ""
    ? request<T>(`/api${path}`, init)
    : fedRequest<T>(peerId, path, init);
}

/** One session-scoped endpoint, as the table (api-local.ts) declares it: the
 * peer id ("" = this server, see sessionRequest), the session id, then the
 * call's own args. The rest is `never[]` so every entry stays free to
 * declare the args it takes — the surfaces below recover them. */
export type SessionRoute = (
  peerId: string,
  sessionId: string,
  ...args: never[]
) => Promise<unknown>;

/** The table as `api` takes it: this server is the only machine, so every
 * method keeps the session id and the call's own args. */
export type SessionScoped<T> = {
  [K in keyof T]: T[K] extends (
    peerId: string,
    ...args: infer P
  ) => Promise<infer R> ? (...args: P) => Promise<R>
    : never;
};

/** The table as `sessionApi` takes it: the tab key already names the peer
 * and the session, so every method keeps only the call's own args. */
export type TabScoped<T> = {
  [K in keyof T]: T[K] extends (
    peerId: string,
    sessionId: string,
    ...args: infer A
  ) => Promise<infer R> ? (...args: A) => Promise<R>
    : never;
};

/** The table's session-scoped calls for one machine, with the peer id fixed
 * (this server is "", see sessionRequest) — what `api` spreads in. A mapped
 * type has no runtime counterpart, so the object is built entry by entry and
 * asserted once here: each entry's own signature is the table's, uncast. */
export function sessionCalls<T extends Record<string, SessionRoute>>(
  routes: T,
  peerId: string,
): SessionScoped<T> {
  const calls: Record<string, unknown> = {};
  for (const [name, route] of Object.entries(routes)) {
    calls[name] = (sessionId: string, ...args: never[]) =>
      route(peerId, sessionId, ...args);
  }
  return calls as SessionScoped<T>;
}

/** The same table for one tab (see sessionApi): its key already named the
 * peer and the session, so the methods keep only the call's own args — built
 * and asserted exactly like sessionCalls. */
export function tabCalls<T extends Record<string, SessionRoute>>(
  routes: T,
  peerId: string,
  sessionId: string,
): TabScoped<T> {
  const calls: Record<string, unknown> = {};
  for (const [name, route] of Object.entries(routes)) {
    calls[name] = (...args: never[]) => route(peerId, sessionId, ...args);
  }
  return calls as TabScoped<T>;
}

/** Build a prompt request body. Images are data URLs; the payload sent to
 * the agent is the base64 data without the `data:<mime>;base64,` header.
 * `mode` (optional) attaches mode metadata so the server creates a
 * ModeMessage (short text + badge in the UI) instead of a plain user
 * message. */
export function promptBody(
  text: string,
  images?: PendingImage[],
  mode?: ModePrompt,
) {
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
    ...(mode ? { mode } : {}),
  };
}
