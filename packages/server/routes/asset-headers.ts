/**
 * The response headers of one published asset (a session's visuals and the
 * files `chat_attach` sent).
 *
 * Both routes identify an asset by a name the store generated and never
 * reuses, so the bytes behind a name never change and the response can be
 * cached forever. The other rules are the same too: never let a browser
 * sniff the type, and — for SVG, which an asset URL can render as a document
 * of its own — bring a policy that allows nothing. One builder so the two
 * routes cannot drift apart on any of them.
 */

/** Fresh names, immutable bytes. */
const IMMUTABLE_CACHE = "private, max-age=31536000, immutable";

export interface AssetHeadersInput {
  mimeType: string;
  /** The name the user knows the file by (a download keeps it). Omitted for
   * a visual, which is only ever displayed inline. */
  downloadName?: string;
}

export function assetHeaders(input: AssetHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": input.mimeType,
    "cache-control": IMMUTABLE_CACHE,
    "x-content-type-options": "nosniff",
  };
  if (input.downloadName !== undefined) {
    // An image is shown in place; anything else is a file to keep. What this
    // route lets a browser RENDER is the server's decision, not the client's.
    const inline = input.mimeType.startsWith("image/");
    headers["content-disposition"] = `${
      inline ? "inline" : "attachment"
    }; filename*=UTF-8''${encodeURIComponent(input.downloadName)}`;
  }
  if (input.mimeType === "image/svg+xml") {
    // An SVG carries script; opened as a document, the page's CSP does not
    // apply to it.
    headers["content-security-policy"] = "default-src 'none'; sandbox";
  }
  return headers;
}
