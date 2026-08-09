/**
 * Frontend-safe shared helpers: pure functions and constants used by the
 * web UI, the CLI, and the server. This module must stay free of
 * runtime dependencies (no db / pi imports) because esbuild bundles it
 * into the browser client; the web package imports it via
 * `@lumisca/core/shared`.
 */

/** Settings-table key for the UI theme. */
export const THEME_KEY = "theme";

/** Tool names of the built-in coding tools. Single source of truth shared
 * with the UI, so the tool registry can never drift from the
 * implementations (tool names are part of the agent-visible contract). */
export const TOOL_READ_FILE = "read_file";
export const TOOL_WRITE_FILE = "write_file";
export const TOOL_EDIT = "edit";
export const TOOL_LIST_DIR = "list_dir";
export const TOOL_BASH = "bash";
export const TOOL_GREP = "grep";
export const TOOL_GLOB = "glob";

/**
 * Reasoning-effort levels for a model. "off" disables thinking; the rest
 * match pi-ai's ThinkingLevel so values pass straight into the agent.
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** User-facing labels for the thinking levels. Shared by the web UI and
 * the CLI so the level names stay consistent. */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

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
  /** Stored thinking level for this model ("off" when unset). */
  thinkingLevel?: ThinkingLevel;
  /** The thinking levels this model actually supports (at least ["off"]). */
  thinkingLevels?: ThinkingLevel[];
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

/** "123K ctx" style model metadata for pickers and lists.
 * Text-only: the web UI renders a Tabler icon for reasoning models next to
 * this, and the CLI appends its own terminal marker (see cli/select.ts). */
export function formatModelMeta(contextWindow?: number): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K ctx`);
  return parts.join(" ");
}
