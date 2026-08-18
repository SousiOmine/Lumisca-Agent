/**
 * Frontend-safe shared helpers: pure functions and constants used by the
 * web UI, the CLI, and the server. This module must stay free of
 * runtime dependencies (no db / pi imports) because esbuild bundles it
 * into the browser client; the web package imports it via
 * `@lumisca/core/shared`.
 */

/** Human-readable message of any thrown value. Shared by the core, the
 * server layer, the CLI, and the web UI so the pattern never varies. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** Settings-table key for the command safety check: before bash / eval /
 * async_bash run, the fast model judges whether the command is safe.
 * "1" enables the check; unset (or any other value) = disabled. */
export const COMMAND_SAFETY_ENABLED_KEY = "command_safety_enabled";

/** Settings-table key for the approved-commands record: a JSON array of
 * approval entries that were judged safe once and now skip the check. */
export const COMMAND_SAFETY_APPROVALS_KEY = "command_safety_approvals";

/** What kind of payload the safety check judges; the record is keyed by
 * this plus the resolved cwd, so approvals never cross kinds or
 * directories. */
export type CommandSafetyKind = "bash" | "eval";

/** One recorded approval of the command safety check. `hash` (SHA-256 of
 * kind + resolved cwd + the exact command) is what later checks match
 * against; the raw command is never persisted — only this redacted display
 * form, so secrets inside commands (API keys, Authorization headers, ...)
 * stay out of the settings file and the settings UI. */
export interface CommandApproval {
  hash: string;
  kind: CommandSafetyKind;
  /** The resolved absolute working directory the command was approved in. */
  cwd: string;
  /** The command with secret values redacted, for display only. */
  command: string;
}

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
export const TOOL_TASK = "task";
export const TOOL_TASK_OUTPUT = "task_output";
export const TOOL_SEND_MESSAGE = "send_message";
/** Discover tools held in the session's tool registry (not preloaded into
 * the LLM context): search returns their names and argument summaries. */
export const TOOL_SEARCH = "tool_search";
/** Execute a tool found through tool_search by name — the single dispatch
 * point for tools whose definitions stay out of the LLM context. */
export const TOOL_CALL = "tool_call";

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

/** Kind of sub-agent the `task` tool launches. `explore` is read-only
 * research; `general` carries the full coding tool set. */
export type SubagentType = "explore" | "general";

/** Lifecycle state of one sub-agent task. */
export type SubagentStatus = "running" | "finished" | "failed" | "aborted";

/** Snapshot of one sub-agent task (the `task` tool). Carried by the task
 * events and the tasks resync endpoint, so it lives in the frontend-safe
 * shared module (like the todo plan). */
export interface TaskInfo {
  agentId: string;
  parentAgentId: string;
  subagentType: SubagentType;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  finishedAt?: number;
  /** The final response text (finished states) or the tail of the live
   * response (running). */
  text: string;
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
  /** The credential method the provider accepts. "oauth" providers get a
   * login flow in the settings UI instead of an API-key field. */
  authType?: ProviderAuthType;
}

/** Credential method of a provider ("api_key" for API-key entry, "oauth"
 * for the subscription/login flow). Shared with the settings UI so it can
 * choose the right control. */
export type ProviderAuthType = "api_key" | "oauth";

/** One event a login flow notifies the UI about (device code, auth URL,
 * info, progress). Mirrors the minimal shape the web client needs to drive
 * the user through the OAuth flow; independent of the pi-ai's own event
 * type so the frontend stays pi-free. */
export type ProviderLoginEvent =
  | {
    type: "info";
    message: string;
    links?: { url: string; label?: string }[];
  }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
    type: "device_code";
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }
  | { type: "progress"; message: string };

/** A prompt a login flow needs the user to answer; the UI renders the
 * matching input and posts the value back. */
export type ProviderLoginPrompt =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
    type: "select";
    message: string;
    options: { id: string; label: string; description?: string }[];
  }
  | { type: "manual_code"; message: string; placeholder?: string };

/** Polled snapshot of one in-flight login session (the server runs the
 * flow; the client polls until "done" / "error" / "cancelled"). */
export interface ProviderLoginSnapshot {
  sessionId: string;
  providerId: string;
  status: "starting" | "waiting" | "done" | "error" | "cancelled";
  /** Events in arrival order; the client renders new ones past the last
   * one it has seen. */
  events: ProviderLoginEvent[];
  /** The prompt awaiting an answer, if any. `id` is what the client posts
   * back to respond. */
  prompt?: ProviderLoginPrompt & { id: string };
  error?: string;
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

/** Images attachable to one prompt (the composer's cap and the server's
 * validation limit — one constant so the UI can never exceed the API). */
export const MAX_PROMPT_IMAGES = 8;

/** Build a `data:<mime>;base64,<data>` URL (previews, rewind restore). */
export function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/** Strip a `data:<mime>;base64,` header from a data URL — the API payload
 * carries the bare base64. Pass-through when there is no header. */
export function stripDataUrlHeader(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/** Minimal server-config shape accepted by serializeMcpServers (config
 * fields only; the live status fields of McpServerInfo are ignored). */
export interface McpServerConfigLike {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
}

/** Serialize a list of MCP server configs into `.mcp.json` text (the
 * app-level config the settings UI PUTs and the workspace file format).
 * Shared by the core (serializeMcpConfig) and the web settings UI so the
 * format can never drift between them. */
export function serializeMcpServers(servers: McpServerConfigLike[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    if (server.type === "stdio") {
      entry.command = server.command;
      if (server.args.length > 0) entry.args = server.args;
    } else {
      entry.url = server.url;
      if (Object.keys(server.headers).length > 0) {
        entry.headers = server.headers;
      }
    }
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    if (server.cwd !== undefined) entry.cwd = server.cwd;
    if (!server.enabled) entry.enabled = false;
    mcpServers[server.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2) + "\n";
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
