import type { Context, Next } from "hono";
import { upgradeWebSocket as bunUpgradeWebSocket } from "hono/bun";
import { isAllowedOrigin } from "./security.ts";

/**
 * Hono's Bun WebSocket helper, with the plain-HTTP case handled here.
 *
 * The Bun adapter calls `server.upgrade` for every request that reaches the
 * route; without a server in the context (a direct `app.fetch`, as the
 * security tests use) it throws, and a plain GET to `/ws` answers 500. A
 * request that did not ask for an upgrade is not a WebSocket handshake: it
 * falls through to the router, which answers 404 like any other unknown
 * path. The actual upgrade path is the adapter's, unchanged.
 *
 * Every handshake is checked here, not per route: browsers send an Origin on
 * WebSocket handshakes and CORS does not apply to WS, so without this any
 * website could open ws://127.0.0.1:<port>/ws, `/api/share/host` or the
 * stella screen and read agent events and the desktop picture. Non-browser
 * clients send no Origin; they are gated by the loopback-only Host check.
 */
export const upgradeWebSocket: typeof bunUpgradeWebSocket = ((
  createEvents: (c: Context) => unknown,
) => {
  const handler = bunUpgradeWebSocket(createEvents as never);
  return (c: Context, next: Next) => {
    // Check before the upgrade test: a foreign page must not learn a socket
    // route's shape either, and the existing direct-fetch tests exercise the
    // handshake without the upgrade header.
    const origin = c.req.header("origin");
    if (
      origin !== undefined &&
      !isAllowedOrigin(origin, c.req.header("host"))
    ) {
      return c.text("Forbidden: cross-origin WebSocket", 403);
    }
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return next();
    }
    return handler(c, next);
  };
}) as typeof bunUpgradeWebSocket;
