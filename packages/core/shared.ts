/**
 * Frontend-safe shared helpers: pure functions and constants used by the
 * web UI, the CLI, and the server (SSR). This module must stay free of
 * runtime dependencies (no db / pi imports) because esbuild bundles it
 * into the browser client; the web package imports it via
 * `@lumisca/core/shared`.
 */

/** Settings-table key for the UI theme. Shared with the server (SSR). */
export const THEME_KEY = "theme";

/** Provider summary for pickers and lists. Shared by the server routes
 * (which build these) and the web UI (which renders them). */
export interface ProviderInfo {
  id: string;
  name: string;
  configured?: boolean;
  source?: string;
}

/** Model summary with enablement info, for pickers and the settings UI. */
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  enabled?: boolean;
}

/** Concatenate the text blocks of a message/tool-result content array
 * (user messages may also carry a plain string). */
export function contentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** "123K ctx 🧠" style model metadata for pickers and lists.
 * Shared by the web UI and the CLI so model display stays consistent. */
export function formatModelMeta(
  contextWindow?: number,
  reasoning?: boolean,
): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K ctx`);
  if (reasoning) parts.push("🧠");
  return parts.join(" ");
}
