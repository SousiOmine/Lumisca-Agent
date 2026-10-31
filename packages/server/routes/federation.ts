import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/http-status";
import { errorMessage } from "@lumisca/core";
import type { PeerStatus } from "@lumisca/core/shared";
import { AppError } from "./util.ts";
import type { FederationClient } from "../federation.ts";

/** How long the peer-reachability probe may take (see the route below): long
 * enough for a slow tailnet hop, short enough that one unreachable peer does
 * not hold the session list for a full request budget. */
const PEER_PROBE_TIMEOUT_MS = 3000;

/** Response headers a proxied answer keeps. Each one is a statement only the
 * machine that produced the body can make:
 *
 * - `content-disposition`: the name a download keeps (`chat_attach`);
 * - `cache-control`: whether the client may reuse the answer (the asset
 *   routes say "forever", and that must survive the hub);
 * - `etag` / `vary`: the validators a cache re-checks with;
 * - `content-security-policy`: what an SVG served by the peer may execute;
 * - `x-content-type-options`: no type sniffing of that body.
 *
 * Not `content-encoding`: the hub's own fetch decoded the body, so the
 * client would be told to decompress plain text. Not `content-length` for
 * the same reason (and a re-compressed response has a new length).
 */
const PROXIED_RESPONSE_HEADERS = [
  "content-disposition",
  "cache-control",
  "etag",
  "vary",
  "content-security-policy",
  "x-content-type-options",
] as const;

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
   * the machine whose sessions this hub can list and proxy. It runs with a
   * short budget of its own: the question is "is this machine up", and the
   * session list waits on the answer before it can show anything, so one
   * unreachable peer must not hold the whole list for a full request
   * budget. */
  app.get("/fed/peers", async (c) => {
    const peers = await Promise.all(
      fed.peers().map(async (peer) => {
        try {
          await fed.requestWithTimeout(
            peer,
            "GET",
            "/api/health",
            PEER_PROBE_TIMEOUT_MS,
          );
          const status: PeerStatus = {
            id: peer.id,
            name: peer.name,
            url: peer.url,
            ok: true,
          };
          return status;
        } catch (error) {
          const status: PeerStatus = {
            id: peer.id,
            name: peer.name,
            url: peer.url,
            ok: false,
            error: errorMessage(error),
          };
          return status;
        }
      }),
    );
    return c.json({ peers });
  });

  /** Generic per-peer proxy: any method, any path below `/fed/:peerId/`.
   * The body is passed through verbatim and the peer's response is
   * streamed back.
   *
   * A proxied response is not just its JSON: the peer decides the type, the
   * download name (`chat_attach`'s files), whether the result may be cached,
   * and what an SVG may execute. Dropping those headers made a file arrive
   * under a random name and an SVG arrive without its policy — the browser
   * was told less than the machine that owns the file said. `content-encoding`
   * is deliberately NOT copied: this server's own `fetch` decoded the body,
   * so passing the header on would make the client decompress plain text. */
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
    const headers: Record<string, string> = {
      "content-type": res.headers.get("content-type") ?? "application/json",
    };
    for (const name of PROXIED_RESPONSE_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const status = res.status as ContentfulStatusCode;
    return res.body === null
      ? c.body(null, status, headers)
      : c.body(res.body, status, headers);
  });

  return app;
}
