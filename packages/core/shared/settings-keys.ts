/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */
import { safeJsonParse } from "./misc.ts";

/*
 * Every settings-table key lives in this module: it is the single source of
 * truth for the key space, so a key can never drift between the module that
 * writes it and the module that reads or guards it.
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

/** Settings-table key for the command safety check: before bash / eval /
 * async_bash run, the fast model judges whether the command is safe.
 * "1" enables the check; unset (or any other value) = disabled. */
export const COMMAND_SAFETY_ENABLED_KEY = "command_safety_enabled";

/** Settings-table key for the approved-commands record: a JSON array of
 * approval entries that were judged safe once and now skip the check. */
export const COMMAND_SAFETY_APPROVALS_KEY = "command_safety_approvals";

/** Settings-table key for saved prompts: a JSON array of SavedPrompt
 * entries that can be inserted via the `/prompt` slash menu. */
export const SAVED_PROMPTS_KEY = "saved_prompts";

/** Settings-table key holding the app-level MCP server config (JSON). It may
 * contain secrets (env vars, headers), so it is protected from the generic
 * settings surface. */
export const APP_MCP_SETTINGS_KEY = "mcp_servers";

/** Settings-table key holding the server-side connection registry. It
 * contains tokens, so it is protected from the generic settings surface. */
export const CONNECTIONS_KEY = "connections";

/** Settings-table key holding the array of user provider configs (JSON). */
export const USER_PROVIDERS_KEY = "user_providers";

/** Prefix of the per-model enablement key (`model_enabled:<provider>:<model>`);
 * the value is "1" for enabled, absent for the default. */
export const MODEL_ENABLED_PREFIX = "model_enabled:";

/** Prefix of the per-model thinking-level key
 * (`model_thinking:<provider>:<model>`). */
export const MODEL_THINKING_PREFIX = "model_thinking:";

/** A saved prompt registered by the user: `id` is the short identifier for
 * the slash command lookup (e.g. "translate"), `label` is the display name
 * shown in the menu, and `prompt` is the text inserted into the composer. */
export interface SavedPrompt {
  id: string;
  label: string;
  prompt: string;
}

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
  const parsed = safeJsonParse<unknown>(raw);
  if (
    typeof parsed === "object" && parsed !== null &&
    typeof (parsed as ModelPreference).provider === "string" &&
    typeof (parsed as ModelPreference).modelId === "string"
  ) {
    return parsed as ModelPreference;
  }
  return undefined;
}

/** Parse saved prompts from the settings store; an empty/missing/malformed
 * value returns an empty array. */
export function parseSavedPrompts(
  raw: string | undefined | null,
): SavedPrompt[] {
  const parsed = safeJsonParse<unknown>(raw);
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (e): e is SavedPrompt =>
        typeof e === "object" && e !== null &&
        typeof e.id === "string" && e.id.length > 0 &&
        typeof e.label === "string" &&
        typeof e.prompt === "string",
    );
  }
  return [];
}

/** Serialize saved prompts for the settings store. */
export function serializeSavedPrompts(prompts: SavedPrompt[]): string {
  return JSON.stringify(prompts);
}

/** Theme preference stored in settings; "system" follows the OS color
 * scheme. The resolved "light"|"dark" scheme is applied on the client. */
export type ThemeSetting = "light" | "dark" | "system";
