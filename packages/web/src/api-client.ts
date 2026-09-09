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

/** Bind a session-scoped call to its owner: `local`/`remote` take the
 * session id first, the returned function takes only the call args. Collapses
 * the `(sessionId) => ...` / `(p, sessionId) => ...` closures every
 * sessionApi entry repeats. */
export function sessionRouted<T, A extends unknown[]>(
  peerId: string,
  sessionId: string,
  local: (sessionId: string, ...args: A) => Promise<T>,
  remote: (peerId: string, sessionId: string, ...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return peerRouted(
    peerId,
    (...args) => local(sessionId, ...args),
    (p, ...args) => remote(p, sessionId, ...args),
  );
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
