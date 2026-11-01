/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db, no Node APIs), bundled into the browser client. */
import { safeJsonParse } from "./misc.ts";

/*
 * Every settings-table key lives in this module: it is the single source of
 * truth for the key space, so a key can never drift between the module that
 * writes it and the module that reads or guards it.
 */

/** Settings-table key for the UI theme. */
export const THEME_KEY = "theme";

/** Settings-table key for the app language ("ja" | "en"; see
 * shared/i18n). It is the single source of the language for BOTH the UI and
 * the session's system prompt, so the server must hold it: the prompt is
 * generated server-side when a session is created, and the language in
 * effect at that moment is what the session keeps (the prompt is
 * snapshotted). Unset means "not chosen yet": the first page load resolves
 * it from the browser (Accept-Language), then the machine's locale, and
 * stores the result, so the value is never ambiguous afterwards. */
export const LANGUAGE_KEY = "language";

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

/** Settings-table key holding the web-search configuration: a JSON object
 * naming the default provider and, per provider, its API key. It contains
 * secrets, so it is protected from the generic settings surface (the
 * /web-search routes read and write it). */
export const WEB_SEARCH_KEY = "web_search";

/** Settings-table key for computer use (the agent driving this machine's
 * screen, mouse and keyboard). "1" enables it; unset (or any other value)
 * = disabled — the feature is opt-in, because a run can click and type
 * anywhere on the machine. The flag decides which tools a session gets, so
 * changing it rebuilds the open sessions (see LumiscaCore.setComputerUseEnabled). */
export const COMPUTER_USE_ENABLED_KEY = "computer_use_enabled";

/** Settings-table key for the Wayland screen-sharing permission (the
 * portal's restore token). Machine state, not a secret: the token only lets
 * the portal skip its consent dialog for this user's own session, and it is
 * useless to anyone who cannot already reach this machine's D-Bus. Stored so
 * that a restart does not ask the user again. */
export const COMPUTER_USE_SESSION_TOKEN_KEY = "computer_use_session_token";

/** Settings-table key for the standalone server's automatic updates: the
 * periodic check, the download, and applying a verified package (the new
 * version takes effect at the next start). "1" = on (the default),
 * "0" = off. The desktop shell keeps its own copy of this flag in its
 * settings file, because the page it shows may be served by a remote
 * server. */
export const UPDATE_AUTO_KEY = "update_auto";

/** Settings-table key for restarting automatically once an update is
 * applied. "1" = on, unset (or any other value) = off (the default): the
 * user restarts, which is the only moment live agent sessions are cut. */
export const UPDATE_AUTO_RESTART_KEY = "update_auto_restart";

/** Settings-table key for saved prompts: a JSON array of SavedPrompt
 * entries that can be inserted via the `/prompt` slash menu. */
export const SAVED_PROMPTS_KEY = "saved_prompts";

/** Settings-table key enabling automatic context compaction. "1" = on (the
 * default), "0" = off. */
export const COMPACTION_ENABLED_KEY = "compaction_enabled";

/** Settings-table key for the SHARE of the model's window left free when
 * compaction triggers, as a percentage. The conversation is condensed once
 * it would come closer than this to the window.
 *
 * A share, not a token count: 16k of a 32k window is half of it, and 16k of
 * a 1M window is a rounding error. A fixed reservation made every large
 * window compact at 98% — one turn away from a rejected request — and made
 * a small one compact almost immediately. */
export const COMPACTION_RESERVE_PERCENT_KEY = "compaction_reserve_percent";

/** Settings-table key for the SHARE of the window kept verbatim after a
 * compaction, as a percentage. The cut lands on a unit boundary, so the
 * retained tail is this share rounded up. */
export const COMPACTION_KEEP_RECENT_PERCENT_KEY =
  "compaction_keep_recent_percent";

/** The compactor's default reservation: 8% of the window (pi's 16k against
 * a 200k window, which is where the old fixed default came from). */
export const COMPACTION_DEFAULT_RESERVE_PERCENT = 8;

/** The compactor's default retention: 20% of the window.
 *
 * Larger than pi's 10% (20k against 200k): with a share, a small window
 * reaches the threshold with very little history, and a 10% tail can still
 * be over the threshold after one pass — the check then spends a second
 * summarization call on it. A fifth of the window is enough history to keep
 * the conversation readable and usually enough to fit the next request. */
export const COMPACTION_DEFAULT_KEEP_RECENT_PERCENT = 20;

/** Compaction tuning read from the settings table; omitted fields keep the
 * compactor's defaults (see ai/context-compaction.ts). */
export interface CompactionPolicyInput {
  enabled?: boolean;
  /** Percent of the window (0-100). */
  reservePercent?: number;
  /** Percent of the window (0-100). */
  keepRecentPercent?: number;
}

/** Parse a non-negative integer setting; undefined when unset, blank, or
 * not a number. */
export function parseNonNegativeIntSetting(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Parse the compaction tuning from the settings store (the keys above).
 * Unset, blank and invalid values are omitted, so the compactor's defaults
 * apply; `enabled` follows the "1"/"0" convention of the other flags. */
export function parseCompactionPolicyInput(
  read: (key: string) => string | undefined,
): CompactionPolicyInput {
  const input: CompactionPolicyInput = {};
  const enabled = read(COMPACTION_ENABLED_KEY);
  if (enabled !== undefined && enabled.trim() !== "") {
    input.enabled = enabled !== "0";
  }
  const reservePercent = parsePercentSetting(
    read(COMPACTION_RESERVE_PERCENT_KEY),
  );
  if (reservePercent !== undefined) input.reservePercent = reservePercent;
  const keepRecentPercent = parsePercentSetting(
    read(COMPACTION_KEEP_RECENT_PERCENT_KEY),
  );
  if (keepRecentPercent !== undefined) {
    input.keepRecentPercent = keepRecentPercent;
  }
  return input;
}

/** Parse a percentage setting: a whole number in 0-100. Undefined when
 * unset, blank, or out of range — an out-of-range value is refused rather
 * than clamped, so a typo does not silently become a different policy. */
export function parsePercentSetting(
  raw: string | undefined,
): number | undefined {
  const value = parseNonNegativeIntSetting(raw);
  return value !== undefined && value <= 100 ? value : undefined;
}

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
