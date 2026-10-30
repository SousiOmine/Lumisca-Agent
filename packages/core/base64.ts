/**
 * Base64 for binary tool payloads (image reads, rendered PDF pages, VM
 * transfers). One home so the chunking strategy cannot drift.
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

/** Encode UTF-8 text as base64 (the VM writes files this way). */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Decode a standard base64 string to bytes. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
