import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/http-status";
import { errorMessage } from "@lumisca/core";
import { AppError } from "./util.ts";
import type { FederationClient } from "../federation.ts";

/**
 * Federated (hub-and-spoke) API. The UI is served by the hub; everything
 * below `/fed/:peerId/` proxies to the peer that owns the resource, so the
 * agent runs on the machine that owns the workspace. All routes are
 * hub-token-gated like the rest of /api.
 *
 * A single generic proxy route replaces one mirror endpoint per API
 * surface: the peer's own routes are authoritative (validation included),
 * so an endpoint added to `/api` needs no `/fed` counterpart.
 *
 * Workspaces are not merged here any more. Which machine a window works on
 * is the desktop title bar's choice (`components/ConnectionPicker.tsx`),
 * which displays one server at a time: a list mixing several machines'
 * folder sets asked the user to pick a machine twice (title bar and the new
 * session screen) and made one of the two answers wrong. Sessions still
 * come from peers for the session list, so the peers' reachability is
 * reported.
 */
export function federationRoutes(fed: FederationClient): Hono {
  const app = new Hono();

  const requirePeer = (c: Context) => {
    const peerId = c.req.param("peerId");
    if (!peerId) {
      throw new AppError("Peer ID missing in path", 400);
    }
    const peer = fed.find(peerId);
    if (!peer) {
      throw new AppError(`Peer not found: ${peerId}`, 404);
    }
    return peer;
  };

  /** Reachability of every registered peer, with the name and URL of its
   * registry entry. A peer that does not answer is reported (`ok: false`)
   * instead of being dropped: the session list skips it, and the settings
   * screen is where it is repaired.
   *
   * The probe is the peer's `/api/health`, which is the same answer the
   * desktop shell's connection check reads: a machine that answers it is
   * the machine whose sessions this hub can list and proxy. */
  app.get("/fed/peers", async (c) => {
    const peers = await Promise.all(
      fed.peers().map(async (peer) => {
        try {
          await fed.request(peer, "GET", "/api/health");
          return {
            id: peer.id,
            name: peer.name,
            url: peer.url,
            ok: true as const,
            error: undefined as string | undefined,
          };
        } catch (error) {
          return {
            id: peer.id,
            name: peer.name,
            url: peer.url,
            ok: false as const,
            error: errorMessage(error),
          };
        }
      }),
    );
    return c.json({ peers });
  });

  /** Generic per-peer proxy: any method, any path below `/fed/:peerId/`.
   * The body is passed through verbatim and the peer's response is
   * streamed back with its status and content type. */
  app.all("/fed/:peerId/*", async (c) => {
    const peer = requirePeer(c);
    // Hono 4.x does not expose the splat via param("*") (matches but
    // stays empty), so the remainder is sliced from the full path.
    const prefix = `/api/fed/${peer.id}/`;
    const rest = c.req.path.startsWith(prefix)
      ? c.req.path.slice(prefix.length)
      : "";
    const search = new URL(c.req.url).search;
    const raw = await c.req.text();
    const res = await fed.request(
      peer,
      c.req.method,
      `/api/${rest}${search}`,
      undefined,
      raw.length > 0 ? raw : undefined,
    );
    const headers = {
      "content-type": res.headers.get("content-type") ?? "application/json",
    };
    const status = res.status as ContentfulStatusCode;
    return res.body === null
      ? c.body(null, status, headers)
      : c.body(res.body, status, headers);
  });

  return app;
}
