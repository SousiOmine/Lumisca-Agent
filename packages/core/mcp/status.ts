/**
 * The status of one MCP server, as the settings UI draws it.
 *
 * Separate from manager.ts so config.ts (the merged config) can describe a
 * server's status without importing the manager that imports it: the shape
 * travels with the config shape (McpServerInfo extends this one), so it
 * belongs beside neither implementation.
 */

/** Status snapshot of one server, for the settings UI. `status` is
 * widened to include "not_started" so the same union serves the merged
 * config+status surface (McpServerInfo); the manager itself only ever
 * reports "ok" or "error". */
export interface McpServerStatus {
  name: string;
  type: "stdio" | "http";
  enabled: boolean;
  /** Number of tools discovered (0 until the first successful listing). */
  toolCount: number;
  status: "ok" | "error" | "not_started";
  error?: string;
  /** The failure is "this server wants an OAuth sign-in" rather than a
   * broken server, so the settings UI can offer the sign-in instead of only
   * showing the message. */
  needsAuth?: boolean;
}
