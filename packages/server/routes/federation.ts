import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Workspace } from "@lumisca/core";
import { errorMessage } from "@lumisca/core";
import { AppError, parseBody } from "./util.ts";
import type { FederationClient } from "../federation.ts";

/** The slice of the core these routes need (interface segregation). */
export interface FederationApi {
  listWorkspaces(): Workspace[];
}

/** Forward a peer response to the UI, keeping status and JSON body. */
async function forward(
  c: Context,
  promise: Promise<Response>,
): Promise<Response> {
  const res = await promise;
  const text = await res.text();
  return c.body(text, res.status as ContentfulStatusCode, {
    "content-type": res.headers.get("content-type") ?? "application/json",
  });
}

/**
 * Federated (hub-and-spoke) API. The UI is served by the hub; everything
 * below proxies to the peer that owns the resource, so the agent runs on
 * the machine that owns the workspace. All routes are hub-token-gated like
 * the rest of /api.
 */
export function federationRoutes(
  core: FederationApi,
  fed: FederationClient,
): Hono {
  const app = new Hono();

  const requirePeer = (c: Context) => {
    const peer = fed.find(c.req.param("peerId"));
    if (!peer) {
      throw new AppError(`Peer not found: ${c.req.param("peerId")}`, 404);
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

  // --- filesystem browsing (workspace creation on a peer) -----------------

  app.get("/fed/:peerId/fs/roots", (c) => {
    const peer = requirePeer(c);
    return forward(c, fed.request(peer, "GET", "/api/fs/roots"));
  });

  app.get("/fed/:peerId/fs/browse", (c) => {
    const peer = requirePeer(c);
    const path = c.req.query("path") ?? "";
    if (path === "") throw new AppError("path is required", 400);
    return forward(
      c,
      fed.request(
        peer,
        "GET",
        `/api/fs/browse?path=${encodeURIComponent(path)}`,
      ),
    );
  });

  // --- workspaces on a peer ------------------------------------------------

  app.post("/fed/:peerId/workspaces", async (c) => {
    const peer = requirePeer(c);
    const body = await parseBody<{ name?: unknown; folders?: unknown }>(c);
    return forward(c, fed.request(peer, "POST", "/api/workspaces", body));
  });

  /** @-mention file suggestions for a workspace owned by a peer. */
  app.get("/fed/:peerId/workspaces/:wid/files", (c) => {
    const peer = requirePeer(c);
    const query = c.req.query("query") ?? "";
    return forward(
      c,
      fed.request(
        peer,
        "GET",
        `/api/workspaces/${
          encodeURIComponent(c.req.param("wid"))
        }/files?query=${encodeURIComponent(query)}`,
      ),
    );
  });

  app.patch("/fed/:peerId/workspaces/:wid", async (c) => {
    const peer = requirePeer(c);
    const body = await parseBody<{ name?: unknown; folders?: unknown }>(c);
    return forward(
      c,
      fed.request(peer, "PATCH", `/api/workspaces/${c.req.param("wid")}`, body),
    );
  });

  app.delete("/fed/:peerId/workspaces/:wid", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "DELETE", `/api/workspaces/${c.req.param("wid")}`),
    );
  });

  // --- sessions on a peer --------------------------------------------------

  app.post("/fed/:peerId/sessions", async (c) => {
    const peer = requirePeer(c);
    const body = await parseBody<Record<string, unknown>>(c);
    return forward(c, fed.request(peer, "POST", "/api/sessions", body));
  });

  app.get("/fed/:peerId/sessions/:sid", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "GET", `/api/sessions/${c.req.param("sid")}`),
    );
  });

  app.get("/fed/:peerId/sessions/:sid/messages", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "GET", `/api/sessions/${c.req.param("sid")}/messages`),
    );
  });

  app.post("/fed/:peerId/sessions/:sid/open", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "POST", `/api/sessions/${c.req.param("sid")}/open`),
    );
  });

  app.post("/fed/:peerId/sessions/:sid/close", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "POST", `/api/sessions/${c.req.param("sid")}/close`),
    );
  });

  app.delete("/fed/:peerId/sessions/:sid", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "DELETE", `/api/sessions/${c.req.param("sid")}`),
    );
  });

  app.post("/fed/:peerId/sessions/:sid/prompt", async (c) => {
    const peer = requirePeer(c);
    const body = await parseBody<{ text?: unknown }>(c);
    return forward(
      c,
      fed.request(
        peer,
        "POST",
        `/api/sessions/${c.req.param("sid")}/prompt`,
        body,
      ),
    );
  });

  app.post("/fed/:peerId/sessions/:sid/abort", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(peer, "POST", `/api/sessions/${c.req.param("sid")}/abort`),
    );
  });

  app.post("/fed/:peerId/sessions/:sid/model", async (c) => {
    const peer = requirePeer(c);
    const body = await parseBody<{ provider?: unknown; modelId?: unknown }>(c);
    return forward(
      c,
      fed.request(
        peer,
        "POST",
        `/api/sessions/${c.req.param("sid")}/model`,
        body,
      ),
    );
  });

  // --- model picker data for remote sessions -------------------------------

  app.get("/fed/:peerId/providers", (c) => {
    const peer = requirePeer(c);
    return forward(c, fed.request(peer, "GET", "/api/providers"));
  });

  app.get("/fed/:peerId/providers/:pid/models", (c) => {
    const peer = requirePeer(c);
    return forward(
      c,
      fed.request(
        peer,
        "GET",
        `/api/providers/${encodeURIComponent(c.req.param("pid"))}/models`,
      ),
    );
  });

  app.put(
    "/fed/:peerId/providers/:pid/models/:mid/thinking-level",
    async (c) => {
      const peer = requirePeer(c);
      const body = await parseBody<{ level?: unknown }>(c);
      return forward(
        c,
        fed.request(
          peer,
          "PUT",
          `/api/providers/${encodeURIComponent(c.req.param("pid"))}/models/${
            encodeURIComponent(c.req.param("mid"))
          }/thinking-level`,
          body,
        ),
      );
    },
  );

  return app;
}
