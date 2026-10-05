import type { McpServerInfo } from "../../types.ts";

/** The configuration fields of a server, as a plain object. The live
 * status fields (`toolCount` / `status` / `error`) are excluded, so two
 * snapshots of the same configuration always compare equal. Shared by the
 * settings list's stale-edit check and the detail form's test-result
 * matching: both must compare exactly the fields a save writes. */
export function mcpConfigFields(
  server: McpServerInfo,
): Record<string, unknown> {
  return {
    name: server.name,
    type: server.type,
    enabled: server.enabled,
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    url: server.url,
    headers: server.headers,
  };
}

/** Fingerprint of one draft server: the configuration a connection test
 * ran against. A test result whose key differs from the form's current key
 * describes an earlier edit. */
export function mcpDraftKey(server: McpServerInfo): string {
  return JSON.stringify(mcpConfigFields(server));
}
