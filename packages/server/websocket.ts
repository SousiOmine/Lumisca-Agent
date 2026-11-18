import type { Context, Next } from "hono";
import { upgradeWebSocket as bunUpgradeWebSocket } from "hono/bun";

/**
 * Hono's Bun WebSocket helper, with the plain-HTTP case handled here.
 *
 * The Bun adapter calls `server.upgrade` for every request that reaches the
 * route; without a server in the context (a direct `app.fetch`, as the
 * security tests use) it throws, and a plain GET to `/ws` answers 500. A
 * request that did not ask for an upgrade is not a WebSocket handshake: it
 * falls through to the router, which answers 404 like any other unknown
 * path. The actual upgrade path is the adapter's, unchanged.
 */
export const upgradeWebSocket: typeof bunUpgradeWebSocket = ((
  createEvents: (c: Context) => unknown,
) => {
  const handler = bunUpgradeWebSocket(createEvents as never);
  return (c: Context, next: Next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return next();
    }
    return handler(c, next);
  };
}) as typeof bunUpgradeWebSocket;
