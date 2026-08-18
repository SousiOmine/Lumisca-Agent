/** A server connection entry — a client-side registry that lets the user
 * switch between servers from the settings UI. Shared by web clients
 * (server-side copy); stored in the settings file. */
export interface ConnectionEntry {
  id: string;
  name: string;
  url: string;
  token: string;
}

/** Settings-table key holding the server-side connection registry. It
 * contains tokens, so it is protected from the generic settings surface. */
export const CONNECTIONS_KEY = "connections";

function isConnectionEntry(value: unknown): value is ConnectionEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.url === "string" &&
    typeof e.token === "string"
  );
}

/** Parse the stored registry; malformed or absent values yield []. */
export function parseConnections(value: string | undefined): ConnectionEntry[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConnectionEntry);
  } catch {
    return [];
  }
}
