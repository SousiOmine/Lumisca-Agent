import { CoreError } from "../errors.ts";
import {
  APP_MCP_SETTINGS_KEY,
  COMMAND_SAFETY_APPROVALS_KEY,
  CONNECTIONS_KEY,
} from "../shared/mod.ts";
import { CREDENTIAL_KEY_PREFIX } from "./credentials.ts";

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
  if (key === APP_MCP_SETTINGS_KEY) {
    // The app MCP config may contain secrets (env vars, headers).
    return "MCP configuration cannot be accessed through this endpoint";
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
