import { apiPath, enc, paths, stripDataUrlHeader } from "@lumisca/core/shared";
import type { ModePrompt, PendingFile, PendingImage } from "./types.ts";

declare global {
  /** Embedded by the server when LUMISCA_TOKEN auth is enabled. */
  var __LUMISCA_TOKEN__: string | undefined;
  /** Origin of the server this page talks to. Set only by the desktop
   * shell's bundled UI, which is served from `tauri://localhost` and must
   * address the API on another origin. Unset in a page the server served:
   * the API is then on the page's own origin, and paths stay relative. */
  var __LUMISCA_API__: string | undefined;
}

/** Origin of the API, without a trailing slash. Empty means the page's own
 * origin (the server serves both the UI and the API). Read at use time: a
 * test that installs the global after this module loads must still see it. */
export function apiBase(): string {
  const base = globalThis.__LUMISCA_API__;
  return base === undefined || base === "" ? "" : base.replace(/\/+$/, "");
}

/** One API path as an absolute URL when the UI is bundled, or as it is when
 * the server served this page. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

/** A server URL for a request the browser makes itself (`<img>`, `<a download>`,
 * a WebSocket): those cannot carry the token header, so the token rides as
 * the query parameter the server's guard also accepts. A URL that already
 * names a token is left alone. */
export function withToken(url: string): string {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const base = apiBase();
  const target = isAbsolute ? url : apiUrl(url);
  const token = pageToken();
  if (token === undefined || token === "") {
    // A page the server served keeps its relative URLs: they are what the
    // page's own markup checks against (see MarkdownBlock's visual base).
    return base === "" && !isAbsolute ? url : target;
  }
  const parsed = new URL(
    target,
    globalThis.location?.href ?? "http://localhost/",
  );
  if (!parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", token);
  }
  return base === "" && !isAbsolute
    ? `${parsed.pathname}${parsed.search}`
    : parsed.toString();
}

/** A WebSocket URL for `path`: the API origin in the desktop shell, the
 * page's own origin when the server served this page. Browsers cannot set a
 * header on a handshake, so the token travels in the query string. */
export function wsUrl(path: string): string {
  const origin = globalThis.location;
  const base =
    apiBase() === ""
      ? origin === undefined
        ? "http://localhost"
        : `${origin.protocol}//${origin.host}`
      : apiBase();
  const url = new URL(path, `${base}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = pageToken();
  if (token !== undefined && token !== "") url.searchParams.set("token", token);
  return url.toString();
}

/** Optional per-instance token (embedded in the page by the server).
 * Attached to every request; browsers cannot set WebSocket headers, so the
 * WS URL carries it as a query parameter instead.
 *
 * Read at use time rather than captured when this module loads. The token is
 * a page-level global set before the app bundle runs, but a test that sets it
 * after another test's import must still see it; capturing it made the
 * module's behaviour depend on file order. */
export function pageToken(): string | undefined {
  return globalThis.__LUMISCA_TOKEN__;
}

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

/** Classify an answer that refused the call: the status decides whether
 * retrying could help, and the body's `{ error }` (when it sent one) is what
 * the reader is shown. `body` is the answer's text, not a parsed object: an
 * error body is often not JSON at all (a proxy's HTML page, a half-dead
 * server), and the status alone still names the failure.
 *
 * The upload's XHR cannot use `request` (it needs `upload.onprogress`), so it
 * reads its own answer — through this function, so both transports sort the
 * same failure the same way. */
export function httpError(status: number, body: string): ApiError {
  let detail: string | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    if (parsed && typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // Not the server's sentence: the status is all there is to say.
  }
  const message = detail ?? `Request failed: ${status}`;
  return new ApiError(message, status < 500 ? "http-4xx" : "http-5xx", {
    status,
    detail,
  });
}

/** Classify a 2xx whose body was not the JSON the call was promised (a
 * captive portal's login page, a proxy that answered for the server): the
 * call produced no value, and saying "unexpected token <" would blame the
 * reader's input. `error` is the parser's own rejection, whose message the
 * logs keep. */
export function parseError(error: unknown, status: number): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(message, "parse", { status });
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const token = pageToken();
  if (token) headers.set("x-lumisca-token", token);
  // A caller that brings its own signal keeps it: the timeout is combined
  // with it rather than replacing it (a screen that unmounts cancels too).
  //
  // The deadline is an AbortController and a timer that is ALWAYS cleared,
  // not `AbortSignal.timeout`: that helper's timer stays pending for the
  // whole interval, which keeps the event loop alive for two minutes after
  // every call (the test runner reports exactly that, and a server-side
  // caller would be held open the same way).
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), requestTimeoutMs);
  const signal =
    init?.signal === undefined || init.signal === null
      ? deadline.signal
      : AbortSignal.any([init.signal, deadline.signal]);
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, headers, signal });
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
    throw httpError(res.status, await res.text());
  }
  try {
    return (await res.json()) as T;
  } catch (error) {
    // A 2xx whose body is not JSON: the call produced no value.
    throw parseError(error, res.status);
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

/** One API path from a template in core/shared/api-paths.ts, with the ids
 * encoded as path segments. The server registers the same template (see
 * `routePath`), so the two cannot spell a path differently. */
export function apiPathOf<T extends string>(
  template: T,
  params: TemplateParams<T>,
): string {
  return apiPath(template, params as Record<string, string>);
}

/** The holes a template names, as the object that fills them.
 *
 * The runtime throws when a hole is left unfilled (see `apiPath`), and the
 * caller that asked it to is far from the mistake: the throw lands in a
 * `catch` that keeps the last state, so a wrong parameter name looks like
 * "nothing ever loaded". Deriving the parameter from the template makes that
 * call site a type error instead. */
type TemplateParams<T extends string> =
  T extends `${string}{${infer Hole}}${infer Rest}`
    ? { readonly [K in Hole]: string } & TemplateParams<Rest>
    : unknown;

/** URL base of a session's visual assets (`visual:` image references in its
 * messages resolve against it, always ending with "/"). The machine running
 * the agent owns the assets, so a peer's session is read through the hub's
 * federation proxy: the peer's route under the `/api/fed/<peerId>` prefix —
 * the same shape as every other federated call. */
export function sessionVisualBase(peerId: string, sessionId: string): string {
  const path = apiPathOf(paths.sessionVisualBase, { id: enc(sessionId) });
  return apiUrl(
    peerId === ""
      ? `/api${path}`
      : `/api/fed/${encodeURIComponent(peerId)}${path}`,
  );
}

/** URL base of a session's attachments (the files `chat_attach` sent, always
 * ending with "/"). Same rule as sessionVisualBase: the machine running the
 * agent owns the files, so a peer's are read through the federation proxy. */
export function sessionAttachmentBase(
  peerId: string,
  sessionId: string,
): string {
  const path = apiPathOf(paths.sessionAttachmentBase, {
    id: enc(sessionId),
  });
  return apiUrl(
    peerId === ""
      ? `/api${path}`
      : `/api/fed/${encodeURIComponent(peerId)}${path}`,
  );
}

/** URL of one stella agent's icon (always the local server: stella is a mode
 * of this installation, not a peer's session). The name is the file the
 * store generated, which is why the icon changes URL when the picture
 * changes — the response is cached forever. */
export function stellaAgentIconUrl(agentId: string, name: string): string {
  return withToken(
    apiUrl(
      `/api${apiPathOf(paths.stellaAgentIcon, {
        id: enc(agentId),
        name: enc(name),
      })}`,
    ),
  );
}

/** Where a prompt's own files are read back from: the conversation's upload
 * route, which reads them out of the machine. `ref` is appended by the
 * caller as a query parameter (see PromptAttachments). */
export function stellaUploadBase(agentId: string): string {
  return apiUrl(
    `/api${apiPathOf(paths.conversationUpload, { agentId: enc(agentId) })}`,
  );
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
  return (...args) =>
    peerId === "" ? local(...args) : remote(peerId, ...args);
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
  ) => Promise<infer R>
    ? (...args: P) => Promise<R>
    : never;
};

/** The table as `sessionApi` takes it: the tab key already names the peer
 * and the session, so every method keeps only the call's own args. */
export type TabScoped<T> = {
  [K in keyof T]: T[K] extends (
    peerId: string,
    sessionId: string,
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => Promise<R>
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
 * stella's conversation prompt). Pictures are shared by both; `uploads` are
 * stella's alone, because only a conversation has a machine to copy a file
 * into. */
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
    // Files already travelled in chunks: the prompt names the transfers the
    // upload route finished (see prompt-upload.ts and the server's
    // prompt-uploads.ts). A file whose transfer has no id would be a prompt
    // that silently lost an attachment, so it fails here instead.
    ...(files && files.length > 0
      ? {
          uploads: files.map((file) => {
            if (file.uploadId === undefined || file.status !== "done") {
              throw new Error(`${file.name} has not finished uploading`);
            }
            return file.uploadId;
          }),
        }
      : {}),
    ...(mode ? { mode } : {}),
  };
}
