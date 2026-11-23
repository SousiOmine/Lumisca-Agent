/**
 * One stored asset as an HTTP response: the asset routes (`visuals`,
 * `attachments`, a stella icon, a file a prompt brought into the machine)
 * each wrote the same headers, body and preview branch by hand, and two of
 * them used a bare `new Response`, which drops headers middleware set with
 * `c.header()` (the auth cookie, for one).
 *
 * `c.newResponse` is the form that keeps them.
 */
import * as fsp from "node:fs/promises";
import { basename } from "node:path";
import type { Context } from "hono";
import { renderPreview } from "../../core/media/preview.ts";
import {
  ensurePreview,
  previewPathOf,
} from "../../core/media/preview-cache.ts";
import { assetHeaders } from "./asset-headers.ts";

export interface AssetResponse {
  bytes: ArrayBuffer;
  mimeType: string;
  /** The name the browser saves the file under; omitted for images shown
   * inline under their URL. */
  downloadName?: string;
}

export function assetResponse(c: Context, asset: AssetResponse): Response {
  const headers = assetHeaders({
    mimeType: asset.mimeType,
    ...(asset.downloadName === undefined
      ? {}
      : { downloadName: asset.downloadName }),
  });
  return c.newResponse(asset.bytes, 200, headers);
}

/** A file an asset route answers with: where it is, and what the response
 * says it is. */
export interface AssetFile {
  path: string;
  mimeType: string;
  /** The name the user knows the file by (a download keeps it). */
  downloadName?: string;
}

/** Bytes a store read itself. A file that lives in the machine has no host
 * path, so there is nothing to read twice. */
export interface AssetBytes {
  bytes: Uint8Array;
  mimeType: string;
  /** The name the user knows the file by (a download keeps it). */
  downloadName?: string;
}

/**
 * A picture is drawn small: the conversation gets a downscaled copy, and
 * `preview=0` asks for the original — what a click opens, and what the model
 * reads. Where that copy comes from differs by store, and only here:
 *
 * - `"stored"`: the source is a file whose bytes never change (a name the
 *   store generated and never reuses), so the copy is produced once and kept
 *   beside it (see media/preview-cache.ts) — one read on every draw after.
 * - `"rendered"`: the source has no such guarantee (a file in the machine,
 *   which the agent may change at any moment), so a stored copy could outlive
 *   it and the copy is rendered per request instead.
 * - `"none"`: the asset is never downscaled (an icon).
 */
export type AssetPreview = "stored" | "rendered" | "none";

/**
 * What one asset route answers with. The source and the preview are one
 * union because they constrain each other: a stored copy needs a file to put
 * the copy beside, a rendered one needs the bytes the store already read.
 *
 * `resolvePath` raises the route's own 404 when the request names nothing the
 * store serves, so every surface keeps its own vocabulary ("Visual not
 * found: …" rather than a generic one).
 */
export type ServeAssetOptions =
  | { preview: "stored"; resolvePath: () => Promise<AssetFile> }
  | { preview: "rendered"; resolvePath: () => Promise<AssetBytes> }
  | { preview: "none"; resolvePath: () => Promise<AssetFile | AssetBytes> };

/** The bytes as the body of a response. Copied into a buffer of their own: a
 * buffer read from disk is a view into a possibly larger one, and the whole
 * of it would otherwise travel. */
function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function respond(
  c: Context,
  bytes: ArrayBuffer,
  source: AssetFile | AssetBytes,
): Response {
  return assetResponse(c, {
    bytes,
    mimeType: source.mimeType,
    ...(source.downloadName === undefined
      ? {}
      : { downloadName: source.downloadName }),
  });
}

/** The bytes of a stored file. The asset is bounded by the store's limit
 * (a few MiB), so buffering it needs no stream handling. */
async function readFile(path: string): Promise<ArrayBuffer> {
  return bodyOf(await fsp.readFile(path));
}

/**
 * Answer with one asset: the small copy by default, the original on
 * `preview=0`, and the headers every asset surface shares.
 */
export async function serveAsset(
  c: Context,
  options: ServeAssetOptions,
): Promise<Response> {
  const wantsCopy =
    options.preview !== "none" && c.req.query("preview") !== "0";

  if (options.preview === "stored") {
    const source = await options.resolvePath();
    if (wantsCopy) {
      const preview = await ensurePreview(
        source.path,
        previewPathOf(source.path, basename(source.path)),
        source.mimeType,
      );
      if (preview !== undefined) return respond(c, bodyOf(preview), source);
    }
    return respond(c, await readFile(source.path), source);
  }

  if (options.preview === "rendered") {
    const source = await options.resolvePath();
    const preview = wantsCopy
      ? await renderPreview(source.bytes, source.mimeType)
      : undefined;
    // Nothing to downscale (already small, or not a picture this module can
    // decode): the original is the answer, and smaller than a re-encode.
    return respond(c, bodyOf(preview ?? source.bytes), source);
  }

  const source = await options.resolvePath();
  const bytes =
    "bytes" in source ? bodyOf(source.bytes) : await readFile(source.path);
  return respond(c, bytes, source);
}
