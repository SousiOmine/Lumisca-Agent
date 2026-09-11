/**
 * Base64 encoding for binary tool payloads (image reads, rendered PDF
 * pages). One home so the chunking strategy cannot drift between tools.
 */

/** Encode bytes as a standard (non-URL-safe) base64 string. Chunked so a
 * large buffer never blows the argument limit of `String.fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
