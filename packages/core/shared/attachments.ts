/**
 * Frontend-safe shared helpers (see shared/mod.ts): the files an agent
 * attaches to the chat for the user, and the limits both sides of one call
 * agree on.
 *
 * An attachment is a file the agent hands over — an image to look at, a
 * document to open, a report to download. The bytes are copied into the
 * session's own store (see session/attachments.ts), so what the user sees
 * keeps showing what the agent sent even after the original file changes,
 * and the store's names are the only addresses the route serves.
 *
 * Images are shown inline; everything else is offered as a download. That
 * split is decided here, once, because the route, the store and the UI all
 * have to answer it the same way: a file the route marks `inline` had better
 * be one the UI can draw, and a name the UI links had better be one the
 * route serves.
 */

import { RASTER_IMAGE_MIME_BY_EXTENSION } from "./mime.ts";

/** Most files one `chat_attach` call may attach. A turn that produced a
 * dozen images is better served by two calls than by a wall of thumbnails,
 * and the cap keeps one call's result small enough to stay readable. */
export const MAX_ATTACHMENTS_PER_CALL = 10;

/** Largest single attachment (bytes). The same cap the visual store uses:
 * a peer's session serves its assets through the federation proxy, which
 * carries a whole-response deadline, so a bigger file would arrive as a
 * timeout rather than as a file — and a timeout looks like a broken app. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Largest total of one call (bytes). Ten files at the single-file cap
 * would still be a 40 MiB response for a peer; this keeps the whole call
 * inside what a browser will render without stalling. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 16 * 1024 * 1024;

/** Content type per extension the store may hold, for the files it shows
 * inline. Extensions absent from this map are still attachable — they are
 * downloaded rather than displayed, which is what an `.xlsx` or a `.zip`
 * wants anyway. SVG is deliberately absent: an SVG is a document that can
 * carry script, and serving one inline would mean deciding a script policy
 * for it. As a download it is just a file. */
export const INLINE_IMAGE_MIME_BY_EXTENSION: Readonly<
  Record<string, string>
> = RASTER_IMAGE_MIME_BY_EXTENSION;

/** The extensions of INLINE_IMAGE_MIME_BY_EXTENSION (error messages list
 * them). */
export const INLINE_IMAGE_EXTENSIONS: readonly string[] = Object.keys(
  INLINE_IMAGE_MIME_BY_EXTENSION,
);

/** Whether a file with this extension is shown inline rather than offered
 * as a download. Accepts the extension with its dot, in any case. */
export function isInlineImageExtension(extension: string): boolean {
  return extension.toLowerCase() in INLINE_IMAGE_MIME_BY_EXTENSION;
}

/** Content type for a non-inline attachment: the browser decides what to do
 * with it, and `application/octet-stream` is what every archive, document
 * and unknown format gets. A wrong guess would be worse than none (a
 * `.json` served as `text/html` is a security problem, not a nicety), so
 * only the formats that are unambiguous are named. */
export function attachmentMimeType(extension: string): string {
  const suffix = extension.toLowerCase();
  return INLINE_IMAGE_MIME_BY_EXTENSION[suffix] ??
    DOWNLOAD_MIME_BY_EXTENSION[suffix] ?? "application/octet-stream";
}

/** Content types of the non-image formats worth naming. Everything else is
 * `application/octet-stream` (see attachmentMimeType). */
const DOWNLOAD_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** The longest original file name the store keeps for a download. Long
 * names exist (a generated report's title is a sentence); the header that
 * carries it is bounded, and a truncated name still identifies the file. */
export const MAX_ATTACHMENT_NAME_CHARS = 120;

/** One attachment as a client draws it: what the tool's result carries and
 * what the conversation's projection publishes. */
export interface AttachmentRef {
  /** The name the store generated (12 hex characters and the extension); a
   * client appends it to the session's attachment base to read the file. */
  name: string;
  /** The original file name, for the download's name and the card's label.
   * Bounded by MAX_ATTACHMENT_NAME_CHARS. */
  displayName: string;
  /** Size in bytes (the card shows it). */
  size: number;
  /** True when the browser shows the file inline (an image); false when it
   * offers a download. Decided by the extension (isInlineImageExtension). */
  inline: boolean;
}

/** Sanitize a path's last segment into a display name: a name that cannot
 * address another directory, is not empty, and fits the cap. Shared by the
 * tool (which reads the file) and the store (which keeps the name), so the
 * two cannot disagree about what the card shows. */
export function attachmentDisplayName(from: string): string {
  const base = from.replace(/\\/g, "/").split("/").pop() ?? "";
  // Control characters would break a header or a filename; strip them
  // without a regex (a control-character class fails the linter).
  const cleaned = [...base]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  const name = cleaned === "" ? "file" : cleaned;
  return name.length > MAX_ATTACHMENT_NAME_CHARS
    ? name.slice(0, MAX_ATTACHMENT_NAME_CHARS)
    : name;
}

/** The attachment list a `chat_attach` result carries in `details`, or none
 * when the details are not the shape this build wrote (a stored result from
 * an older build, a hand-edited row): a card shows nothing rather than a
 * broken row. One parser, used by the code-mode transcript and by the
 * server's conversation projection, so the two cannot draw different files
 * from the same result. */
export function attachmentsOfDetails(details: unknown): AttachmentRef[] {
  if (typeof details !== "object" || details === null) return [];
  const list = (details as { attachments?: unknown }).attachments;
  if (!Array.isArray(list)) return [];
  const refs: AttachmentRef[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const ref = item as Partial<AttachmentRef>;
    if (
      typeof ref.name === "string" &&
      typeof ref.displayName === "string" &&
      typeof ref.size === "number" &&
      typeof ref.inline === "boolean"
    ) {
      refs.push({
        name: ref.name,
        displayName: ref.displayName,
        size: ref.size,
        inline: ref.inline,
      });
    }
  }
  return refs;
}

/** A byte count as the card shows it: "512 B", "1.2 KB", "3.4 MB". One
 * decimal below 10 of a unit and none above, so a column of sizes stays
 * readable. Pure, so the card and its tests share one answer. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 10 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

/** One file the user attached to a prompt: what the client shows under the
 * bubble, and what the model is told about where the file is. The bytes are
 * in the machine (`/vm/uploads.ts`), not in the message — a message travels
 * through the websocket, the transcript and the window endpoint, and 10 MiB
 * of base64 on that path is what makes a conversation feel broken. */
export interface PromptFileRef {
  /** The name to show (the user's own, cleaned). */
  name: string;
  /** Absolute path inside the machine; the model is told this. */
  path: string;
  /** Size in bytes (the card shows it). */
  size: number;
}

/** The notice appended to the model's copy of a prompt that carried files.
 * English, like every other system-facing text. Kept beside the shape it
 * describes so the sentence and the field cannot drift apart. */
export function promptFileNotice(files: readonly PromptFileRef[]): string {
  if (files.length === 0) return "";
  return [
    "[Attached files]",
    "The user attached these files. They are inside the machine:",
    ...files.map((file) =>
      `- ${file.name}: ${file.path} (${formatAttachmentSize(file.size)})`
    ),
    "",
    "Open them with the read or bash tools.",
  ].join("\n");
}

/** The text the model receives for a prompt: what the user wrote, then the
 * notice naming the attached files. The conversation shows the user's own
 * words only (and the cards), so the notice lives here rather than in the
 * message itself. */
export function textWithFileNotice(
  text: string,
  files: readonly PromptFileRef[],
): string {
  const notice = promptFileNotice(files);
  if (notice.length === 0) return text;
  return text.length === 0 ? notice : `${text}\n\n${notice}`;
}
