import type { SessionInfo } from "@lumisca/core";
import { Hono } from "hono";
import {
  ensurePreview,
  previewPathOf,
} from "../../core/media/preview-cache.ts";
import { assetHeaders } from "./asset-headers.ts";
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
    const headers = assetHeaders({ mimeType: visual.mimeType });
    // A picture is drawn small: the conversation gets a downscaled copy, and
    // `preview=0` asks for the original (what a click opens, and what the
    // model reads). The preview is stored beside its source under a name
    // derived from it (see media/preview-cache.ts), so this costs one read
    // after the first draw and can never go stale.
    const wantsPreview = c.req.query("preview") !== "0";
    const preview = wantsPreview
      ? await ensurePreview(
          visual.path,
          previewPathOf(visual.path, name),
          visual.mimeType,
        )
      : undefined;
    if (preview !== undefined) {
      return c.newResponse(preview.buffer as ArrayBuffer, 200, headers);
    }
    const bytes = await Deno.readFile(visual.path);
    // The asset is bounded by the store's limit (4 MiB), so buffering it
    // needs no stream handling; the buffer is an ArrayBuffer of its own.
    return c.newResponse(bytes.buffer as ArrayBuffer, 200, headers);
  });

  return app;
}
