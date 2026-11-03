import type { ModePrompt, PendingFile, PendingImage } from "./types.ts";
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

/**
 * Why a request failed, as the UI has to say it.
 *
 * `message` keeps the raw text the client always threw ("Request failed:
 * 503", the server's own `{ error }`, the fetch rejection's message): it is
 * what the logs and the error-copy button carry, and what code that only
 * reads a message still reads. `kind` is what the reader is told, because
 * "Failed to fetch" is not a sentence in their language and does not say
 * whether retrying could help — see i18n.ts describeError.
 */
export class ApiError extends Error {
  readonly kind: "network" | "http-4xx" | "http-5xx" | "parse";
  /** The HTTP status for `http-4xx` / `http-5xx`, null otherwise. */
  readonly status: number | null;
  /** The server's own explanation, when it sent one. */
  readonly detail: string | null;

  constructor(
    message: string,
    kind: ApiError["kind"],
    options: {
      status?: number | null;
      detail?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
  }
}

/** Classify a failed `fetch`: the request never got an answer, so it is a
 * network failure however the runtime spelled the rejection (a browser's
 * TypeError, a wrapped DOMException). The original error is kept as the
 * cause — the health monitor and the console read it. */
function networkError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(message, "network", { cause: error });
}

/**
 * How long a request may stay unanswered before it is treated as an outage.
 *
 * Without a bound, a server that accepted the connection and then stopped
 * (a hang, a suspended machine, a proxy holding the socket) left the promise
 * pending forever: no error to show, no retry, and — before the composer was
 * fixed — the text already cleared from the field.
 *
 * Generous on purpose. The longest legitimate call is a prompt carrying the
 * maximum attachment (base64 of ~15 MB) or a compaction that summarizes a
 * long history; both are slow uploads, not hangs. The bound only has to be
 * below "the user has given up".
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** The bound `request` applies, as a value a test can shorten. Not a
 * per-call option: every caller would then have to think about it, and the
 * one number that matters is the app's. */
let requestTimeoutMs = REQUEST_TIMEOUT_MS;

/** Replace the request bound (tests only: a two-minute wait is not something
 * a suite can spend). */
export function setRequestTimeoutMs(ms: number): void {
  requestTimeoutMs = ms;
}

/** Why a request timed out: a network failure in every sense the reader
 * cares about (nothing came back, retrying may help), said as its own
 * sentence because "the server never answered" is not the same as "the
 * connection was refused". */
export class TimeoutError extends ApiError {
  constructor(ms: number) {
    super(`Request timed out after ${ms} ms`, "network");
    this.name = "TimeoutError";
  }
}

export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("x-lumisca-token", token);
  // A caller that brings its own signal keeps it: the timeout is combined
  // with it rather than replacing it (a screen that unmounts cancels too).
  //
  // The deadline is an AbortController and a timer that is ALWAYS cleared,
  // not `AbortSignal.timeout`: that helper's timer stays pending for the
  // whole interval, which keeps the event loop alive for two minutes after
  // every call (Deno's test sanitizer reports exactly that, and a server-side
  // caller would be held open the same way).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), requestTimeoutMs);
  const signal = init?.signal === undefined || init.signal === null
    ? deadline.signal
    : AbortSignal.any([init.signal, deadline.signal]);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal });
  } catch (error) {
    // A timeout is not an outage the desktop can restart its way out of any
    // differently from a refused connection, so the monitor is told either
    // way; the message is where the difference is kept.
    notifyServerFailure();
    if (deadline.signal.aborted) throw new TimeoutError(requestTimeoutMs);
    throw networkError(error);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Errors are answered as `{ error }`; a proxy or a half-dead server
    // answers HTML instead, and the status alone still names the failure.
    const body = await res.json().catch(() => null);
    const detail = body && typeof body.error === "string" ? body.error : null;
    const message = detail ?? `Request failed: ${res.status}`;
    throw new ApiError(
      message,
      res.status < 500 ? "http-4xx" : "http-5xx",
      { status: res.status, detail },
    );
  }
  try {
    return await res.json() as T;
  } catch (error) {
    // A 2xx whose body is not JSON (a captive portal's login page, a proxy
    // that answered for the server): the call did not produce a value, and
    // saying "unexpected token <" would blame the reader's input.
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(message, "parse", { status: res.status });
  }
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

/** URL base of a session's attachments (the files `chat_attach` sent, always
 * ending with "/"). Same rule as sessionVisualBase: the machine running the
 * agent owns the files, so a peer's are read through the federation proxy. */
export function sessionAttachmentBase(
  peerId: string,
  sessionId: string,
): string {
  const path = `${sessionPath(sessionId, "/attachment/")}`;
  return peerId === ""
    ? `/api${path}`
    : `/api/fed/${encodeURIComponent(peerId)}${path}`;
}

/** URL of one stella agent's icon (always the local server: stella is a mode
 * of this installation, not a peer's session). The name is the file the
 * store generated, which is why the icon changes URL when the picture
 * changes — the response is cached forever. */
export function stellaAgentIconUrl(agentId: string, name: string): string {
  return `/api/stella/agents/${encodeURIComponent(agentId)}/icon/${
    encodeURIComponent(name)
  }`;
}

/** Where a prompt's own files are read back from: the conversation's upload
 * route, which reads them out of the machine. `ref` is appended by the
 * caller as a query parameter (see PromptFiles). */
export function stellaUploadBase(agentId: string): string {
  return `/api/stella/conversations/${encodeURIComponent(agentId)}/upload`;
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
 * message.
 *
 * Both prompt surfaces send this body (code mode's session prompt and
 * stella's conversation prompt), so an attachment cannot work on one and be
 * silently dropped on the other. */
export function promptBody(
  text: string,
  images?: PendingImage[],
  mode?: ModePrompt,
  files?: PendingFile[],
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
    // Files travel as bytes plus a name: the server writes them into the
    // machine and tells the model where they are (see core's vm/uploads.ts).
    ...(files && files.length > 0
      ? {
        files: files.map((file) => ({
          name: file.name,
          data: stripDataUrlHeader(file.data),
        })),
      }
      : {}),
    ...(mode ? { mode } : {}),
  };
}
