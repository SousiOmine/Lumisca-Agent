/**
 * One stored asset as an HTTP response: the three asset routes (`visuals`,
 * `attachments`, the stella icon and upload) each wrote the same headers and
 * body by hand, and two of them used a bare `new Response`, which drops
 * headers middleware set with `c.header()` (the auth cookie, for one).
 *
 * `c.newResponse` is the form that keeps them.
 */
import type { Context } from "hono";
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
