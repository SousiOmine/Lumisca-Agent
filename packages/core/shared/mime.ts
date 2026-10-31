/**
 * Frontend-safe shared helpers (see shared/mod.ts): pure functions and
 * constants with no runtime dependencies (no db, no Node APIs), bundled into
 * the browser client.
 *
 * Image formats the app reads, serves and stores. Four surfaces used to
 * carry their own copy of the same table — the `read` tool (which turns a
 * raster file into an image block for a vision model), the visual store, the
 * attachment store and the agent-icon store — and the copies differed in
 * exactly one place: whether `.svg` is on the list.
 *
 * That difference is a POLICY, not a typo, so it is expressed here as two
 * tables with the reason beside each:
 *
 * - {@link RASTER_IMAGE_MIME_BY_EXTENSION} — formats that are decoded as
 *   pixels. What everything that DISPLAYS an image uses, including an
 *   `<img>` the browser renders on our behalf.
 * - {@link SVG_MIME_TYPE} — the one vector format. It can carry script, so
 *   it is never shown inline: the visual store accepts it (a reply embeds it
 *   through an `<img>`, which sandboxes the script), while the attachment
 *   and icon stores refuse it (they serve a document whose script policy
 *   nobody decided).
 */

/** Content type per raster extension: the formats a vision model can read
 * and a browser renders as an `<img>` without deciding a script policy. */
export const RASTER_IMAGE_MIME_BY_EXTENSION: Readonly<
  Record<string, string>
> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** The raster extensions, in a stable order (error messages list them). */
export const RASTER_IMAGE_EXTENSIONS: readonly string[] = Object.keys(
  RASTER_IMAGE_MIME_BY_EXTENSION,
);

/** Content type of SVG — accepted by the visual store only (see the module
 * comment). */
export const SVG_MIME_TYPE = "image/svg+xml";

/** The extension of SVG, with its dot. */
export const SVG_EXTENSION = ".svg";
