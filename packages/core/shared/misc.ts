/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */
import type { ThemeSetting } from "./settings-keys.ts";
import type { Workspace } from "../types/workspace.ts";

/** Human-readable message of any thrown value. Shared by the core, the
 * server layer, the CLI, and the web UI so the pattern never varies. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** "123K ctx" style model metadata for pickers and lists.
 * Text-only: the web UI renders a Tabler icon for reasoning models next to
 * this, and the CLI appends its own terminal marker (see cli/select.ts). */
export function formatModelMeta(contextWindow?: number): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K ctx`);
  return parts.join(" ");
}
/** Initial data served by the server's bootstrap script
 * (`/assets/initial-data.js`). Lives here (not in the web package) so the
 * server never imports from `@lumisca/web`: the dependency stays
 * `server → core ← web`. The web package re-exports this type for its own
 * consumers. */
export interface InitialData {
  workspaces: Workspace[];
  theme: ThemeSetting;
}
/** Decode UTF-8 bytes (TextDecoder is available in browsers and Deno, so
 * this stays frontend-safe). Single home for the `new TextDecoder()`
 * pattern scattered across tools and the CLI. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
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
/** Display name for a newly created session. One format shared by the core
 * (web sessions, `"Session ..."`) and the CLI (`run` sessions, `"Run ..."`)
 * so session names never drift between frontends. */
export function formatSessionName(
  date: Date = new Date(),
  prefix = "Session",
): string {
  return `${prefix} ${date.toLocaleString()}`;
}
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
