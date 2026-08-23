/**
 * BrowserBackend: the interface the agent's browser tools talk to, plus
 * every protocol/domain type shared between the backend implementations
 * (Desktop WebView host, CLI browser host) and the tool layer.
 *
 * The backend abstracts "an OS-standard WebView controlled over a local
 * authenticated channel". Hosts receive these operations, run a shared
 * JavaScript probe inside the target page (see probe.js), and return
 * semantic snapshots — never raw HTML.
 *
 * Every method accepts an optional AbortSignal: aborting the caller's run
 * must settle the call (with an error) instead of leaving it hanging.
 */

// --- open ------------------------------------------------------------------

export interface OpenOptions {
  /** Target URL. HTTPS/HTTP on localhost / 127.0.0.1 / ::1 only (see
   * policy.ts); anything else is rejected before reaching a host. */
  url: string;
  /** Window size hints (CSS pixels). Omitted → host default. */
  width?: number;
  height?: number;
  /** Whether the lab window is shown. Default true. */
  visible?: boolean;
}

/** Result of open(): minimal page facts. Full state comes from observe. */
export interface PageInfo {
  url: string;
  /** Current document title ("" when the page has not reported one yet). */
  title?: string;
  /** Document ready state ("loading" | "interactive" | "complete"), or
   * "" when the host has not heard from the page yet. */
  readyState?: string;
}

// --- observe ---------------------------------------------------------------

export interface ObserveOptions {
  /** Include the page-text digest (the largest part of a snapshot).
   * Default true. False keeps subsequent observations lighter. */
  includeText?: boolean;
}

/** One interactive / informative element of the page, in document order. */
export interface ElementInfo {
  /** Stable-ish reference for act(): assigned by the probe, reused for
   * the same element across observations; renumbered after a full page
   * navigation. */
  ref: string;
  tag: string;
  /** Effective ARIA role (explicit or implied, e.g. "button", "textbox",
   * "checkbox", "heading", "link", "combobox", "radio"). */
  role: string;
  /** Accessible name: aria-label / aria-labelledby / <label> / title /
   * text content / placeholder (whichever applies). */
  name: string;
  /** Heading level for role "heading" (e.g. 1..6), else undefined. */
  headingLevel?: number;
  /** Input variant for textbox / combobox ("text", "email", ...). */
  inputType?: string;
  /** Current text value of textbox / searchbox / textarea. */
  value?: string;
  /** Checked state of checkbox / radio. */
  checked?: boolean;
  /** Disabled state (or aria-disabled). */
  disabled: boolean;
  /** false = not rendered (display:none, hidden, zero-size, detached). */
  visible: boolean;
  /** Same-origin href of links (the raw href is kept — the lab only opens
   * local pages, see policy.ts). */
  href?: string;
  /** Short inner text of buttons / links (`name` already covers most). */
  text?: string;
  /** Whether the element currently has focus. */
  focused?: boolean;
}

/** One collected console call (since the previous observation only). */
export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  /** The arguments joined into a single line (bounded). */
  text: string;
}

/** One page error (since the previous observation only). */
export interface PageErrorEntry {
  /** "error" = window error event, "unhandledrejection" = rejected promise
   * nobody handled. */
  kind: "error" | "unhandledrejection";
  message: string;
  /** First line of the stack, when available. */
  detail?: string;
}

export interface NetworkSummary {
  /** In-flight fetch/XHR requests. WebSocket connections are explicitly
   * NOT counted (dev-server hot reload must not keep the page "busy"). */
  active: number;
  /** Completed requests since the last observation. */
  completed: number;
  /** Failed requests since the last observation. */
  failed: number;
  /** Milliseconds since the last request activity, or null when the page
   * never made one. */
  idleMs: number | null;
}

/** Semantic snapshot of the page for the LLM. Bounded in size: at most
 * MAX_SNAPSHOT_ELEMENTS elements, page text capped, console/error entries
 * capped. */
export interface PageSnapshot {
  url: string;
  title: string;
  readyState: string;
  viewport: { width: number; height: number };
  /** Interactive elements and headings, in document order. */
  elements: ElementInfo[];
  /** Digest of the visible text, bounded (see MAX_PAGE_TEXT_CHARS). */
  pageText: string;
  /** Console calls collected since the previous observation. */
  console: ConsoleEntry[];
  /** Page errors collected since the previous observation. */
  errors: PageErrorEntry[];
  network: NetworkSummary;
  /** True when the DOM changed since the previous observation. */
  mutated: boolean;
  /** Names of fields that were truncated to fit the size limits. */
  truncated: string[];
}

// --- act -------------------------------------------------------------------

export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "type"; ref: string; value: string }
  | { kind: "press"; ref?: string; key: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "check"; ref: string }
  | { kind: "uncheck"; ref: string }
  | { kind: "scroll"; ref?: string; x?: number; y?: number }
  | { kind: "reload" };

/** Result of one action. Failures are returned with an error code instead
 * of throwing when they are page problems (unknown ref, broken probe);
 * transport problems throw. */
export interface ActionResult {
  ok: boolean;
  /** Present when ok=false (e.g. "ref_not_found", "probe_missing"). */
  code?: string;
  error?: string;
  /** After a successful click/fill/type: the target element's updated
   * info, so the agent sees the result without a separate observe. */
  element?: ElementInfo;
  /** After reload: the new URL. */
  url?: string;
}

// --- wait ------------------------------------------------------------------

export interface WaitOptions {
  /** What to wait for:
   * - "load": document readyState becomes "complete"
   * - "idle": no active requests and no request activity for `idleMs`
   *   (WebSockets excluded)
   * - "url": location.href contains `urlContains`
   * - "time": sleep for `durationMs`
   */
  until: "load" | "idle" | "url" | "time";
  /** Upper bound for the wait in ms (default 10000). */
  timeoutMs?: number;
  /** For until="idle": quiet period required, ms (default 500). */
  idleMs?: number;
  /** For until="url": substring the URL must contain. */
  urlContains?: string;
  /** For until="time": how long to wait. */
  durationMs?: number;
}

export interface WaitResult {
  ok: boolean;
  reason: "loaded" | "idle" | "url" | "time" | "timeout" | "error";
  durationMs: number;
  /** The reason's detail (e.g. the URL when until="url"). */
  detail?: string;
}

// --- screenshot ------------------------------------------------------------

export interface ScreenshotOptions {
  /** "png" (default) or "jpeg". */
  format?: "png" | "jpeg";
  /** JPEG quality 1..100 (default 80; png ignores it). */
  quality?: number;
}

export interface ImageResult {
  mimeType: string;
  /** Base64-encoded image data (PNG or JPEG). */
  data: string;
  /** Pixel size of the captured surface. */
  width?: number;
  height?: number;
}

// --- backend ---------------------------------------------------------------

/**
 * A controllable browser-ish surface backed by an OS-standard WebView.
 * Desktop: a debug WebviewWindow inside the Tauri shell. CLI: the
 * lumisca-browser-host process. Both are driven over the same local
 * authenticated RPC protocol, so one tool layer serves both.
 */
export interface BrowserBackend {
  open(options: OpenOptions, signal?: AbortSignal): Promise<PageInfo>;
  observe(
    options?: ObserveOptions,
    signal?: AbortSignal,
  ): Promise<PageSnapshot>;
  act(action: BrowserAction, signal?: AbortSignal): Promise<ActionResult>;
  wait(options: WaitOptions, signal?: AbortSignal): Promise<WaitResult>;
  screenshot(
    options?: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ImageResult>;
  /** Release the underlying webview / host process. Idempotent. */
  close(signal?: AbortSignal): Promise<void>;
}

// --- size limits (shared with the hosts) -----------------------------------

/** Max elements in one snapshot. */
export const MAX_SNAPSHOT_ELEMENTS = 300;
/** Max characters of the digest text of a snapshot. */
export const MAX_PAGE_TEXT_CHARS = 4096;
/** Max console entries per observation (oldest kept — the ring buffer). */
export const MAX_CONSOLE_ENTRIES = 200;
/** Max page errors kept in the ring buffer. */
export const MAX_PAGE_ERRORS = 50;
/** Max characters of one console line / error message. */
export const MAX_ENTRY_TEXT_CHARS = 400;
/** Max characters of one element's text field. */
export const MAX_ELEMENT_TEXT_CHARS = 160;
/** Max characters of one element's name. */
export const MAX_ELEMENT_NAME_CHARS = 160;
/** Max characters of a value reported for textboxes. */
export const MAX_ELEMENT_VALUE_CHARS = 400;

// --- RPC protocol ----------------------------------------------------------

/** Host-side RPC method names (the wire protocol; hosts implement these). */
export const RPC_OPEN = "open";
export const RPC_OBSERVE = "observe";
export const RPC_ACT = "act";
export const RPC_WAIT = "wait";
export const RPC_SCREENSHOT = "screenshot";
export const RPC_CLOSE = "close";

/** Request body: POST /rpc, JSON, header `x-lumisca-browser-token`. The
 * id ties the response to the request (correlation only — the protocol is
 * strictly request/response, one request in flight at a time per host). */
export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Success response. */
export interface RpcSuccess {
  id: number;
  ok: true;
  result: unknown;
}

/** Failure response. */
export interface RpcFailure {
  id: number;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type RpcResponse = RpcSuccess | RpcFailure;

/** RPC error codes (stable across hosts; the client maps them to errors
 * without inventing new ones). */
export const RPC_ERROR_NOT_OPEN = "not_open";
export const RPC_ERROR_REF_NOT_FOUND = "ref_not_found";
export const RPC_ERROR_PROBE_MISSING = "probe_missing";
export const RPC_ERROR_PROBE_ERROR = "probe_error";
export const RPC_ERROR_ACTION_FAILED = "action_failed";
export const RPC_ERROR_WAIT_UNSUPPORTED = "wait_unsupported";
export const RPC_ERROR_SCREENSHOT_UNSUPPORTED = "screenshot_unsupported";
export const RPC_ERROR_TIMEOUT = "timeout";
export const RPC_ERROR_TOO_LARGE = "too_large";
export const RPC_ERROR_CLOSED = "closed";
export const RPC_ERROR_AUTH = "auth";
export const RPC_ERROR_INVALID = "invalid";
export const RPC_ERROR_INTERNAL = "internal";

/** Max size of one RPC request body (bytes). */
export const MAX_RPC_REQUEST_BYTES = 64 * 1024;
/** Max size of one RPC response body (bytes) — snapshots stay well under
 * this; oversized results are rejected explicitly, never truncated by the
 * transport. */
export const MAX_RPC_RESPONSE_BYTES = 1024 * 1024;
/** Max screenshot payload (base64 chars ≈ bytes, PNG). Larger captures are
 * refused with a clear error (the tool can retry with a smaller window). */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** Header carrying the per-run random token, and the method/path of the
 * RPC endpoint. Shared by the Deno client and both Rust hosts. */
export const RPC_TOKEN_HEADER = "x-lumisca-browser-token";
export const RPC_PATH = "/rpc";

/** Errors thrown by backends. `code` is one of the RPC_ERROR_* codes (or
 * a transport code below), so callers can branch without string matching. */
export class BrowserBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserBackendError";
  }
}

/** Transport-level codes (not RPC_ERROR_*): the host could not be reached,
 * the request was aborted, or the host sent an unparseable reply. */
export const TRANSPORT_REFUSED = "transport_refused";
export const TRANSPORT_ABORTED = "transport_aborted";
export const TRANSPORT_BAD_REPLY = "transport_bad_reply";
export const TRANSPORT_HTTP = "transport_http";
