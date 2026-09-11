/** Error-message helper (see shared/mod.ts for the frontend-safe contract). */
import type { ThemeSetting } from "./settings-keys.ts";
import type { Workspace } from "../types/workspace.ts";

// ---- errors ---------------------------------------------------------------

/** Human-readable message of any thrown value. Shared by the core, the
 * server layer, the CLI, and the web UI so the rendering never varies.
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
 * pattern scattered across tools and the CLI. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
/** Display name for a newly created session. One format shared by the core
 * (web sessions, `"Session ..."`) and the CLI (`run` sessions, `"Run ..."`)
 * so session names never drift between frontends. */
export function formatSessionName(
  date: Date = new Date(),
  prefix = "Session",
): string {
  return `${prefix} ${date.toLocaleString()}`;
}

// ---- models ---------------------------------------------------------------

/** "123K ctx" style model metadata for pickers and lists.
 * Text-only: the web UI renders a Tabler icon for reasoning models next to
 * this, and the CLI appends its own terminal marker (see cli/select.ts). */
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
 * consumers. */
export interface InitialData {
  workspaces: Workspace[];
  theme: ThemeSetting;
}

// ---- async ----------------------------------------------------------------

/** Race a promise against a timeout: resolves with the promise's value, or
 * with `fallback` when `ms` elapses first. Shared by the web shell bridge
 * and the CLI browser host so the timeout pattern lives once. */
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
