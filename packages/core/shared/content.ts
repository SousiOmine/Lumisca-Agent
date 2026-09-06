/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

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

/** Images attachable to one prompt (the composer's cap and the server's
 * validation limit — one constant so the UI can never exceed the API). */
export const MAX_PROMPT_IMAGES = 8;

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
