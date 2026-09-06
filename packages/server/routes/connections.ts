import { Hono } from "hono";
import type { ConnectionEntry } from "@lumisca/core";
import {
  AppError,
  parseBody,
  requireArray,
  requireNonEmptyString,
  requireString,
} from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface ConnectionsApi {
  getConnections(): ConnectionEntry[];
  setConnections(entries: ConnectionEntry[]): void;
}

/** Coerce a parsed body into ConnectionEntry[]; throws 400 on wrong types
 * or empty URLs instead of silently persisting garbage. */
function connectionList(value: unknown): ConnectionEntry[] {
  const items = requireArray(value, "connections (array)");
  return items.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new AppError("each connection must be an object", 400);
    }
    const e = item as Record<string, unknown>;
    return {
      id: requireNonEmptyString(e.id, "id (string)"),
      name: requireString(e.name, "name (string)"),
      url: requireNonEmptyString(e.url, "url (string)"),
      token: requireString(e.token, "token (string)"),
    };
  });
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
