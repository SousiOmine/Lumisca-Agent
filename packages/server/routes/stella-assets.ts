/**
 * The stella conversation's FILE endpoints: an agent's picture, and a file a
 * prompt brought into the machine.
 *
 * Both answer raw bytes rather than JSON, and both share one rule: the store
 * (or the machine) generates the name, and only a name it generated can be
 * read back. Kept apart from the conversation routes so the JSON surface
 * (open, prompt, rewind, events) reads as one thing, and the asset delivery
 * as another — the two have nothing in common but their path prefix.
 */

import * as fsp from "node:fs/promises";
import type { StellaAgent } from "@lumisca/core";
import { Hono } from "hono";
import { renderPreview } from "../../core/media/preview.ts";
import { assetResponse } from "./asset-response.ts";
import { AppError, notFound } from "./util.ts";

/** The slice of the core the file routes need (interface segregation). */
export interface StellaAssetApi {
  getStellaAgent(id: string): StellaAgent | undefined;
  /** Read one icon the store generated for an agent, or undefined when the
   * name is not one of them. */
  resolveStellaAgentIcon(
    agentId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined>;
  /** Read one file a prompt brought into the machine, or undefined when the
   * machine no longer has it. */
  resolvePromptUpload(
    agentId: string,
    ref: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
}

/** The stella file routes (an agent's icon, a prompt's uploaded file). */
export function stellaAssetRoutes(core: StellaAssetApi): Hono {
  const app = new Hono();

  /** The picture itself.
   *
   * Named by the file the store generated, not by the agent alone: a
   * replaced picture keeps the OLD URL valid for whatever already drew it
   * (the answer is cacheable forever, and a URL whose content changed would
   * keep showing the old face), while a fresh upload gets a fresh name. The
   * agent must exist — a name alone must not tell a caller whether one ever
   * did — and the store answers only names it generated. */
  app.get("/stella/agents/:id/icon/:name", async (c) => {
    const agentId = c.req.param("id");
    if (core.getStellaAgent(agentId) === undefined) {
      throw notFound("Agent", agentId);
    }
    const name = c.req.param("name");
    const icon = await core.resolveStellaAgentIcon(agentId, name);
    if (icon === undefined) {
      throw notFound("Icon", name);
    }
    const bytes = await fsp.readFile(icon.path);
    return assetResponse(c, {
      bytes: bytes.buffer as ArrayBuffer,
      mimeType: icon.mimeType,
    });
  });

  /** One file a prompt brought into the machine, read back for the
   * conversation to draw.
   *
   * The machine is the truth. A file the agent moved, edited or deleted is
   * gone from the conversation too, and the answer is a 404 the client draws
   * as "this file is no longer in the machine" — the ordinary end of a
   * message-app attachment, and the same for a picture and a document. The
   * bytes are never copied into the store, so nothing can show a stale copy
   * of something the machine no longer has.
   *
   * `ref` is the address the transcript carries (`uploads/<batch>/<name>`),
   * validated before it becomes a path, so a caller cannot reach anything
   * outside the agent's uploads folder. */
  app.get("/stella/conversations/:agentId/upload", async (c) => {
    const agentId = c.req.param("agentId");
    const ref = c.req.query("ref") ?? "";
    if (core.getStellaAgent(agentId) === undefined) {
      throw notFound("Agent", agentId);
    }
    const file = await core.resolvePromptUpload(agentId, ref);
    if (file === undefined) {
      throw new AppError("That file is no longer in the machine", 404);
    }
    // A picture is drawn small, so the conversation gets a downscaled copy
    // (`preview=0` asks for the original, which is what a click opens). The
    // bytes are not cached: this file lives in the MACHINE, where the agent
    // may change it at any moment, so a cached preview could outlive its
    // source.
    const wantsPreview = c.req.query("preview") !== "0";
    const bytes = wantsPreview
      ? ((await renderPreview(new Uint8Array(file.bytes), file.mimeType)) ??
        new Uint8Array(file.bytes))
      : new Uint8Array(file.bytes);
    return assetResponse(c, {
      bytes: bytes.buffer as ArrayBuffer,
      mimeType: file.mimeType,
    });
  });

  return app;
}
