import { Hono } from "hono";
import type { SessionInfo } from "@lumisca/core";
import { AppError } from "./util.ts";
import { assetHeaders } from "./asset-headers.ts";
import {
  ensurePreview,
  previewPathOf,
} from "../../core/media/preview-cache.ts";

/** The slice of the core these routes need (interface segregation). */
export interface AttachmentApi {
  getSession(id: string): SessionInfo | undefined;
  /** The file one of a session's attachments names (see
   * LumiscaCore.resolveSessionAttachment). Undefined when the session has no
   * such file. */
  resolveSessionAttachment(
    sessionId: string,
    name: string,
  ): Promise<
    { path: string; mimeType: string; downloadName: string } | undefined
  >;
}

/**
 * Serves the files an agent handed to the user (the `chat_attach` tool in
 * code mode, `send_chat`'s attachments in stella; see
 * core/session/attachments.ts). The route is guarded like the rest of
 * `/api`; a browser reaches it through the token cookie, because an `<img>`
 * cannot send the header the API client uses.
 *
 * Only a name the session's store resolves is served: the store validates
 * the name's shape and keeps every file inside the session's own directory,
 * so the route can never be pointed at another path — and a session must
 * exist, because a name alone must not tell a caller whether one ever did.
 */
export function attachmentRoutes(core: AttachmentApi): Hono {
  const app = new Hono();

  app.get("/sessions/:id/attachment/:name", async (c) => {
    const sessionId = c.req.param("id");
    const name = c.req.param("name");
    if (core.getSession(sessionId) === undefined) {
      throw new AppError(`Session not found: ${sessionId}`, 404);
    }
    const attachment = await core.resolveSessionAttachment(sessionId, name);
    if (attachment === undefined) {
      throw new AppError(`Attachment not found: ${name}`, 404);
    }
    // The download carries the name the user knows, not the store's random
    // one (see asset-headers.ts for the rest of the rules).
    const headers = assetHeaders({
      mimeType: attachment.mimeType,
      downloadName: attachment.downloadName,
    });
    // A picture is drawn small, so the conversation gets a downscaled copy
    // (`preview=0` asks for the original, which is what a click opens). The
    // preview is stored beside its source under a name derived from it (see
    // media/preview-cache.ts), so this costs one read after the first draw.
    const wantsPreview = c.req.query("preview") !== "0";
    const preview = wantsPreview
      ? await ensurePreview(
        attachment.path,
        previewPathOf(attachment.path, name),
        attachment.mimeType,
      )
      : undefined;
    if (preview !== undefined) {
      return new Response(preview.buffer as ArrayBuffer, { headers });
    }
    const bytes = await Deno.readFile(attachment.path);
    return new Response(bytes, { headers });
  });

  return app;
}
