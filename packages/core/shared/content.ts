/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db, no Node APIs), bundled into the browser client. */

/** Concatenate the text blocks of a message/tool-result content array
 * (user messages may also carry a plain string). */
export function contentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Files attachable to one prompt (images and documents alike): the
 * composer's cap and the server's validation limit, so the UI can never
 * exceed the API. */
export const MAX_PROMPT_FILES = 8;

/** Most base64 characters one attached file may carry (~15 MB of bytes).
 * Bounds what a browser can sensibly send in one prompt; the LLM APIs impose
 * their own, smaller limits on images on top of it. */
export const MAX_PROMPT_FILE_BASE64_LENGTH = 20 * 1024 * 1024;

/** Most characters one prompt's text may carry. A bound, not a budget: it is
 * far above any prompt a person writes, and only stops a paste that would
 * fill the model's context in one turn (a log, a whole file). Enforced by the
 * composer (which refuses to grow past it, so the text is never silently cut)
 * and by the API (a client that ignores the field gets a 400 that says why). */
export const MAX_PROMPT_TEXT_LENGTH = 200_000;

/** Build a `data:<mime>;base64,<data>` URL (previews, rewind restore). */
export function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/** Strip a `data:<mime>;base64,` header from a data URL — the API payload
 * carries the bare base64. Pass-through when there is no header. */
export function stripDataUrlHeader(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}
/** The image blocks of a message/tool-result content array (`data` is
 * base64, `mimeType` like `image/png`). */
export function contentImages(
  content: string | Array<{ type: string; data?: string; mimeType?: string }>,
): Array<{ type: "image"; data: string; mimeType: string }> {
  if (typeof content === "string") return [];
  return content.filter(
    (b): b is { type: "image"; data: string; mimeType: string } =>
      b.type === "image" && typeof b.data === "string" &&
      typeof b.mimeType === "string",
  );
}
