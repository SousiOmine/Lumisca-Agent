import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Workspace } from "@lumisca/core";
import { errorMessage } from "@lumisca/core";
import { AppError } from "./util.ts";
import type { FederationClient } from "../federation.ts";

/** The slice of the core these routes need (interface segregation). */
export interface FederationApi {
  listWorkspaces(): Workspace[];
}

/**
 * Federated (hub-and-spoke) API. The UI is served by the hub; everything
 * below `/fed/:peerId/` proxies to the peer that owns the resource, so the
 * agent runs on the machine that owns the workspace. All routes are
 * hub-token-gated like the rest of /api.
 *
 * A single generic proxy route replaces one mirror endpoint per API
 * surface: the peer's own routes are authoritative (validation included),
 * so an endpoint added to `/api` needs no `/fed` counterpart.
 */
export function federationRoutes(
  core: FederationApi,
  fed: FederationClient,
): Hono {
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

  /** Merged workspace list: the hub's own plus every peer's, with the
   * peer's reachability alongside. */
  app.get("/fed/workspaces", async (c) => {
    const local = core.listWorkspaces().map((ws) => ({
      peerId: "",
      peerName: "",
      workspace: ws,
    }));
    const remote = await Promise.all(
      fed.peers().map(async (peer) => {
        try {
          const res = await fed.request(peer, "GET", "/api/workspaces");
          const list = await res.json() as Workspace[];
          return {
            peerId: peer.id,
            peerName: peer.name,
            workspaces: list,
            ok: true as const,
            error: undefined as string | undefined,
          };
        } catch (error) {
          return {
            peerId: peer.id,
            peerName: peer.name,
            workspaces: [] as Workspace[],
            ok: false as const,
            error: errorMessage(error),
          };
        }
      }),
    );
    const workspaces = [
      ...local,
      ...remote.flatMap((r) =>
        r.workspaces.map((ws) => ({
          peerId: r.peerId,
          peerName: r.peerName,
          workspace: ws,
        }))
      ),
    ];
    const peers = remote.map((r) => ({
      id: r.peerId,
      name: r.peerName,
      ok: r.ok,
      error: r.error,
    }));
    return c.json({ workspaces, peers });
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
