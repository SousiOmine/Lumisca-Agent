import type { SessionInfo } from "@lumisca/core";
import { Hono } from "hono";
import { serveAsset } from "./asset-response.ts";
import { notFound } from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface VisualApi {
  getSession(id: string): SessionInfo | undefined;
  /** The file one of a session's published visuals names (see
   * LumiscaCore.resolveSessionVisual). Undefined when the session has no
   * such asset. */
  resolveSessionVisual(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined>;
}

/**
 * Serves the images a session published for its replies (the `visual:`
 * references of an assistant message, see core/shared/visual.ts). The route
 * is guarded like the rest of `/api`; a browser reaches it through the token
 * cookie, because an `<img>` cannot send the header the API client uses.
 *
 * Only a name the session's store resolves is served: the store validates
 * the name's shape and keeps every asset inside the session's own directory,
 * so the route can never be pointed at another file.
 */
export function visualRoutes(core: VisualApi): Hono {
  const app = new Hono();

  app.get("/sessions/:id/visual/:name", async (c) => {
    const sessionId = c.req.param("id");
    const name = c.req.param("name");
    return await serveAsset(c, {
      preview: "stored",
      resolvePath: async () => {
        // The session must exist: an asset outlives nothing, and a name alone
        // must not tell a caller whether a session ever existed.
        if (core.getSession(sessionId) === undefined) {
          throw notFound("Session", sessionId);
        }
        const visual = await core.resolveSessionVisual(sessionId, name);
        if (visual === undefined) {
          throw notFound("Visual", name);
        }
        return visual;
      },
    });
  });

  return app;
}
