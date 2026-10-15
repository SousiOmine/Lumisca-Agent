import { Hono } from "hono";
import type { SessionInfo } from "@lumisca/core";
import { AppError } from "./util.ts";

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

/** Caching of one asset: the name is fresh per publish and never reused, so
 * the bytes behind it never change. */
const IMMUTABLE_CACHE = "private, max-age=31536000, immutable";

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
    // The session must exist: an asset outlives nothing, and a name alone
    // must not tell a caller whether a session ever existed.
    if (core.getSession(sessionId) === undefined) {
      throw new AppError(`Session not found: ${sessionId}`, 404);
    }
    const visual = await core.resolveSessionVisual(sessionId, name);
    if (visual === undefined) {
      throw new AppError(`Visual not found: ${name}`, 404);
    }
    const headers: Record<string, string> = {
      "content-type": visual.mimeType,
      "cache-control": IMMUTABLE_CACHE,
      "x-content-type-options": "nosniff",
    };
    if (visual.mimeType === "image/svg+xml") {
      // An asset URL can be opened as a document of its own (a new tab, a
      // drag-and-drop target), where the page's CSP does not apply: without
      // this, a script an SVG carries would run with the app's origin. The
      // response therefore brings its own policy, which allows nothing.
      headers["content-security-policy"] = "default-src 'none'; sandbox";
    }
    const bytes = await Deno.readFile(visual.path);
    // The asset is bounded by the store's limit (4 MiB), so buffering it
    // needs no stream handling; the buffer is an ArrayBuffer of its own.
    return c.newResponse(bytes.buffer as ArrayBuffer, 200, headers);
  });

  return app;
}
