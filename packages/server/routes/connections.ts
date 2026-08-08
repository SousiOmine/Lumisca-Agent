import { Hono } from "hono";
import type { ConnectionEntry } from "@lumisca/core";
import { AppError, parseBody } from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface ConnectionsApi {
  getConnections(): ConnectionEntry[];
  setConnections(entries: ConnectionEntry[]): void;
}

/** Coerce a parsed body into ConnectionEntry[]; throws 400 on wrong types
 * or empty URLs instead of silently persisting garbage. */
function connectionList(value: unknown): ConnectionEntry[] {
  if (!Array.isArray(value)) {
    throw new AppError("connections (array) is required", 400);
  }
  const entries: ConnectionEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      throw new AppError("each connection must be an object", 400);
    }
    const e = item as Record<string, unknown>;
    if (
      typeof e.id !== "string" || typeof e.name !== "string" ||
      typeof e.url !== "string" || typeof e.token !== "string"
    ) {
      throw new AppError(
        "each connection needs id/name/url/token (strings)",
        400,
      );
    }
    if (e.id.length === 0 || e.url.length === 0) {
      throw new AppError("id and url must not be empty", 400);
    }
    entries.push({ id: e.id, name: e.name, url: e.url, token: e.token });
  }
  return entries;
}

/** Server-side connection registry: the federated peer list. Web clients
 * and the desktop app share this single registry; the desktop shell keeps
 * no copy of its own. */
export function connectionRoutes(
  core: ConnectionsApi,
  onChange?: () => void,
): Hono {
  const app = new Hono();

  app.get("/connections", (c) => {
    return c.json({ connections: core.getConnections() });
  });

  app.put("/connections", async (c) => {
    const body = await parseBody<{ connections?: unknown }>(c);
    core.setConnections(connectionList(body?.connections));
    // The federation client re-reads the list; let it reconnect to peers.
    onChange?.();
    return c.json({ ok: true });
  });

  return app;
}
