import { CoreError } from "../errors.ts";
import {
  APP_MCP_SETTINGS_KEY,
  COMMAND_SAFETY_APPROVALS_KEY,
  COMMAND_SAFETY_ENABLED_KEY,
  COMPACTION_ENABLED_KEY,
  COMPACTION_KEEP_RECENT_PERCENT_KEY,
  COMPACTION_RESERVE_PERCENT_KEY,
  COMPUTER_USE_ENABLED_KEY,
  CONNECTIONS_KEY,
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  LANGUAGE_KEY,
  SAVED_PROMPTS_KEY,
  THEME_KEY,
  UPDATE_AUTO_KEY,
  UPDATE_AUTO_RESTART_KEY,
  USER_PROVIDERS_KEY,
  WEB_SEARCH_KEY,
} from "../shared/mod.ts";
import { CREDENTIAL_KEY_PREFIX } from "./credentials.ts";
import { MCP_OAUTH_KEY_PREFIX } from "../mcp/oauth.ts";

/** The protected-key category of a settings key, or undefined when the
 * key is safe to expose through the generic settings surface. Credentials
 * have their own API (/providers/:id/api-key), the app MCP config its own
 * (/api/mcp), and the connection registry its own (/api/connections);
 * touching any of them through the generic settings surface would bypass
 * those APIs. Single source of truth for both the read/write guard and
 * the listSettings filter. */
export function protectedKeyReason(key: string): string | undefined {
  if (key.startsWith(CREDENTIAL_KEY_PREFIX)) {
    return "credentials cannot be accessed through this endpoint";
  }
  if (key.startsWith(MCP_OAUTH_KEY_PREFIX)) {
    // MCP OAuth tokens and client registrations.
    return "MCP credentials cannot be accessed through this endpoint";
  }
  if (key === APP_MCP_SETTINGS_KEY) {
    // The app MCP config may contain secrets (env vars, headers).
    return "MCP configuration cannot be accessed through this endpoint";
  }
  if (key === WEB_SEARCH_KEY) {
    // The web-search setting holds provider API keys; it has its own routes.
    return "web search configuration cannot be accessed through this endpoint";
  }
  if (key === CONNECTIONS_KEY) {
    // The connection registry contains server tokens.
    return "connection registry cannot be accessed through this endpoint";
  }
  return undefined;
}

/** Throw unless the key may flow through the generic settings surface. */
export function assertNotProtected(key: string): void {
  const reason = protectedKeyReason(key);
  if (reason !== undefined) {
    throw new CoreError(reason, "forbidden");
  }
}

/** Drop every entry that must never be exposed through the generic
 * settings surface: protected keys (credentials, MCP config, connection
 * registry) plus the command-safety approvals record (which has its own
 * API). */
export function filterExposedSettings(
  all: Map<string, string>,
): Map<string, string> {
  const safe = new Map<string, string>();
  for (const [key, value] of all) {
    if (protectedKeyReason(key) !== undefined) continue;
    if (key === COMMAND_SAFETY_APPROVALS_KEY) continue;
    safe.set(key, value);
  }
  return safe;
}

/** Settings keys the generic settings surface may write.
 *
 * The settings file is shared by many owners (the UI's preferences, the
 * model layer's per-model records, the credential store, the MCP config), so
 * an open write endpoint could create or overwrite any of them — a typo in a
 * key, or a client that sends a key it invented, would silently persist a
 * dead entry. The list is therefore an allow-list: a new preference has to
 * be declared here (one line, next to its constant) and cannot be reached by
 * accident.
 *
 * Entries with their own dedicated surface are absent on purpose: credentials
 * (`api_key:*`), the MCP OAuth grants, the web-search configuration, the MCP
 * config, the connection registry and the command-safety approvals are
 * written through their own routes/services, which validate their payloads.
 * Per-model enablement and thinking level are absent too: they are written by
 * the model layer through /providers/:id/models/:modelId, which knows the
 * provider/model pair. */
const MUTABLE_KEYS: ReadonlySet<string> = new Set([
  THEME_KEY,
  LANGUAGE_KEY,
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  COMPUTER_USE_ENABLED_KEY,
  UPDATE_AUTO_KEY,
  UPDATE_AUTO_RESTART_KEY,
  COMMAND_SAFETY_ENABLED_KEY,
  COMPACTION_ENABLED_KEY,
  COMPACTION_RESERVE_PERCENT_KEY,
  COMPACTION_KEEP_RECENT_PERCENT_KEY,
  SAVED_PROMPTS_KEY,
  USER_PROVIDERS_KEY,
]);

/** Throw unless `key` may be written through the generic settings surface. */
export function assertMutableKey(key: string): void {
  if (MUTABLE_KEYS.has(key)) return;
  throw new CoreError(
    `Unknown setting: ${key} (a preference must be declared in ` +
      "settings/guard.ts before it can be written)",
    "invalid",
  );
}
