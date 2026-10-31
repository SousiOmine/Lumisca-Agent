/** Error-message helper (see shared/mod.ts for the frontend-safe contract). */
import type { ThemeSetting } from "./settings-keys.ts";
import type { Workspace } from "../types/workspace.ts";
import {
  DEFAULT_LOCALE,
  type Locale,
  localeTag,
  translate,
} from "./i18n/mod.ts";

// ---- errors ---------------------------------------------------------------

/** Human-readable message of any thrown value. Shared by the core, the
 * server layer, and the web UI so the rendering never varies.
 *
 * Cross-realm errors (thrown inside a `vm` context, e.g. the eval tool's
 * sandbox) are not `instanceof Error` here, so their `message` is read
 * structurally; anything else falls back to `String()`, which keeps the
 * value's own `toString` (the previous behavior). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}

// ---- json -----------------------------------------------------------------

/** Parse JSON without throwing: `undefined` when the text is empty,
 * missing, or malformed. For settings blobs, persisted records, and other
 * best-effort reads where a corrupt value means "unset". Request bodies
 * keep their own validator (server/routes/util.ts) so malformed input
 * still yields a 400. */
export function safeJsonParse<T>(
  text: string | undefined | null,
): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Malformed persisted value → treat as unset (callers apply defaults).
    return undefined;
  }
}
/** Parse JSON or throw with context: for config files (mcp.json,
 * plugin.json, models.json) where a malformed file is a user-facing
 * error, not "unset". Single home for the try/catch shape every config
 * parser shares. */
export function parseJsonOrThrow<T>(
  text: string,
  describe: (detail: string) => Error,
): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw describe(errorMessage(error));
  }
}

// ---- text -----------------------------------------------------------------

/** Decode UTF-8 bytes (TextDecoder is available in browsers and Deno, so
 * this stays frontend-safe). Single home for the `new TextDecoder()`
 * pattern scattered across tools and the client. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** `YYYY-MM-DD HH:MM` on the MACHINE's clock (local time, not UTC). Shared
 * by the history search's head lines and the routine list's times so both
 * read the same clock the user does. Mixing UTC dates with local weekday
 * names is the mistake this exists to prevent. */
export function formatLocalDateTime(at: number | Date): string {
  const date = typeof at === "number" ? new Date(at) : at;
  return `${formatLocalDate(date)} ${pad2(date.getHours())}:${
    pad2(date.getMinutes())
  }`;
}

/** `YYYY-MM-DD` on the machine's clock (local time, not UTC). */
export function formatLocalDate(at: number | Date): string {
  const date = typeof at === "number" ? new Date(at) : at;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${
    pad2(date.getDate())
  }`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The day the machine's clock reads, with its weekday name in the given
 * language: e.g. `2026-08-11 (Tuesday)` / `2026-08-11 (火曜日)`. Both parts
 * come from the same `Date`, so the date and the weekday can never
 * describe different days (a UTC date next to a local weekday name would
 * be off by one for the first hours of a JST day). */
export function formatLocalDay(
  at: Date,
  localeTag: string,
): string {
  return `${formatLocalDate(at)} (${
    at.toLocaleDateString(localeTag, { weekday: "long" })
  })`;
}
/** Display name for a newly created session ("Session <date>" /
 * "セッション <date>"), shown until the title generator replaces it. The
 * language is the session's own (the setting at creation). */
export function formatSessionName(
  locale: Locale = DEFAULT_LOCALE,
  date: Date = new Date(),
): string {
  return translate(locale, "common.sessionName", {
    date: date.toLocaleString(localeTag(locale)),
  });
}

// ---- models ---------------------------------------------------------------

/** "123K ctx" style model metadata for pickers and lists.
 * Text-only: the web UI renders a Tabler icon for reasoning models next to
 * this. */
export function formatModelMeta(contextWindow?: number): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K ctx`);
  return parts.join(" ");
}

// ---- bootstrap ------------------------------------------------------------

/** Initial data served by the server's bootstrap script
 * (`/assets/initial-data.js`). Lives here (not in the web package) so the
 * server never imports from `@lumisca/web`: the dependency stays
 * `server → core ← web`. The web package re-exports this type for its own
 * consumers.
 *
 * Deliberately incomplete: it carries what THIS server can answer without
 * waiting on anyone (its own workspaces; the ones a window shows are always
 * the displayed server's own). The session list still asks the registered
 * peers, so that half is fetched by the client itself (`/api/fed/peers`) —
 * a peer that is down must never delay the first paint. */
export interface InitialData {
  workspaces: Workspace[];
  theme: ThemeSetting;
  /** The app language: the stored setting when one was chosen, else the
   * language resolved from the browser (Accept-Language) at the first page
   * load (see server/app.ts and shared/i18n). The page renders in it from
   * the first paint. */
  language: Locale;
}

// ---- async ----------------------------------------------------------------

/** Wait `ms` milliseconds. The one home for the pattern: the computer-use
 * hosts, the routine scheduler's slot poll, the VM's command polling and the
 * container manager all pause between observations, and a copy per module is
 * how the duration constants and the timer bookkeeping drift. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A pause that ends early when `signal` fires, rejecting with the error
 * `describeAbort()` builds. Both abortable waits in the app need this and
 * differ only in what an abort MEANS to their caller (a rate-limit backoff
 * is a retry that will not happen; a VM wait is an interrupted tool call), so
 * the timing lives here and the error stays their own. */
export function sleepAbortable(
  ms: number,
  signal: AbortSignal | undefined,
  describeAbort: () => Error,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) return Promise.reject(describeAbort());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(describeAbort());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The error an aborted wait rejects with: the standard `AbortError`
 * DOMException, so code that already classifies abort signals (the agent's
 * stream handling) recognises it without another sentinel class. */
export function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

/** Race a promise against a timeout: resolves with the promise's value, or
 * with `fallback` when `ms` elapses first. Shared by the web shell bridge
 * and the desktop notifications so the timeout pattern lives once. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Race a promise against a deadline that FAILS: when `ms` elapses first the
 * returned promise rejects with `describeTimeout()`.
 *
 * The auxiliary LLM calls (the safety check, the goal judge, the eval tool's
 * script) all need this shape rather than {@link withTimeout}'s fallback: a
 * check that did not finish must not read as "no objection". The abort
 * controller is the caller's — a well-behaved stream is closed by aborting
 * it, and the race covers transports that ignore the signal.
 */
export function withTimeoutError<T>(
  promise: Promise<T>,
  ms: number,
  describeTimeout: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(describeTimeout());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
