/**
 * Frontend-safe shared helpers: pure functions and constants used by the
 * web UI, the CLI, and the server. This module must stay free of
 * runtime dependencies (no db / pi imports) because esbuild bundles it
 * into the browser client; the web package imports it via
 * `@lumisca/core/shared`.
 */

/** Settings-table key for the UI theme. */
export const THEME_KEY = "theme";

/** Settings-table key for the fast/cheap auxiliary model. Configured in
 * the settings dialog's model section, separate from the per-session model
 * chosen in the chatbox picker. */
export const FAST_MODEL_KEY = "model_fast";

/** Settings-table key for the model that interprets images on behalf of
 * models without image support. Configured in the settings dialog's model
 * section; the value is the JSON of a {@link ModelPreference}. */
export const IMAGE_MODEL_KEY = "model_image";

/** A global model preference (fast model / image analysis model): the
 * provider + model id pair stored as JSON under the keys above. */
export interface ModelPreference {
  provider: string;
  modelId: string;
}

/** Serialize a model preference for the settings store. */
export function serializeModelPreference(pref: ModelPreference): string {
  return JSON.stringify(pref);
}

/** Parse a stored model preference; undefined when unset, empty, or
 * malformed. */
export function parseModelPreference(
  raw: string | undefined | null,
): ModelPreference | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as ModelPreference).provider === "string" &&
      typeof (parsed as ModelPreference).modelId === "string"
    ) {
      return parsed as ModelPreference;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Theme preference stored in settings; "system" follows the OS color
 * scheme. The resolved "light"|"dark" scheme is applied on the client. */
export type ThemeSetting = "light" | "dark" | "system";

/** Tool names of the built-in coding tools. Single source of truth shared
 * with the UI, so the tool registry can never drift from the
 * implementations (tool names are part of the agent-visible contract). */
export const TOOL_READ = "read";
export const TOOL_WRITE = "write";
export const TOOL_EDIT = "edit";
export const TOOL_LIST_DIR = "list_dir";
export const TOOL_BASH = "bash";
export const TOOL_ASYNC_BASH = "async_bash";
export const TOOL_ASYNC_BASH_STATUS = "async_bash_status";
export const TOOL_ASYNC_BASH_KILL = "async_bash_kill";
export const TOOL_GREP = "grep";
export const TOOL_GLOB = "glob";
export const TOOL_SKILL = "skill";
export const TOOL_EVAL = "eval";
export const TOOL_ASK = "ask";
export const TOOL_TODO = "todo";

/** One option of an ask question, shown as a selectable chip in the UI. */
export interface AskOption {
  label: string;
  description?: string;
}

/** One question the agent asks the user (the `ask` tool). The UI renders
 * it above the composer; the user's answer is returned as the tool result.
 * `multi` (default false) allows several options; `recommended` preselects
 * the option at that index when the question appears. */
export interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  header?: string;
  multi?: boolean;
  recommended?: number;
}

/** The user's answer to one question: the selected option labels (`values`
 * holds one label for single choice, several for multi). */
export interface AskAnswer {
  id: string;
  values: string[];
}

/** State of one todo task (the `todo` tool). `in_progress` is the current
 * task of the plan; at most one task carries it at a time. */
export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";

/** One task of a todo phase. `id` is stable within the session and
 * assigned by the server when the plan is set (e.g. `t1`, `t2`). */
export interface TodoTask {
  id: string;
  name: string;
  status: TodoStatus;
}

/** One phase of the todo plan: a group of tasks (e.g. 調査・実装・テスト).
 * `id` is stable within the session (e.g. `p1`, `p2`). */
export interface TodoPhase {
  id: string;
  name: string;
  tasks: TodoTask[];
}

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

/** The image blocks of a message/tool-result content array (`data` is
 * base64, `mimeType` like `image/png`). */
export function contentImages(
  content: string | Array<{ type: string; data?: string; mimeType?: string }>,
): Array<{ type: "image"; data: string; mimeType: string }> {
  if (typeof content === "string") return [];
  return content.filter(
    (b): b is { type: "image"; data: string; mimeType: string } =>
      b.type === "image" && typeof b.data === "string" &&
      typeof b.mimeType === "string",
  );
}

/** "123K ctx" style model metadata for pickers and lists.
 * Text-only: the web UI renders a Tabler icon for reasoning models next to
 * this, and the CLI appends its own terminal marker (see cli/select.ts). */
export function formatModelMeta(contextWindow?: number): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K ctx`);
  return parts.join(" ");
}
