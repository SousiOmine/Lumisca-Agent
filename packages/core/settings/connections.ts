import { safeJsonParse } from "../shared/mod.ts";

/** A server connection entry — a client-side registry that lets the user
 * switch between servers from the settings UI. Shared by web clients
 * (server-side copy); stored in the settings file. */
export interface ConnectionEntry {
  id: string;
  name: string;
  url: string;
  token: string;
}

/** A row as a list surface sees it: identity and address, no secret. The
 * desktop bridge redacts the token from `connections/list` and hands it out
 * one row at a time through the key-gated `connections/get`. */
export interface ConnectionSummary {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
}

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
  const parsed = safeJsonParse<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isConnectionEntry);
}
