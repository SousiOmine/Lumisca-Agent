import { extname } from "node:path";
import {
  attachmentDisplayName,
  attachmentMimeType,
  type AttachmentRef,
  isInlineImageExtension,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_CHARS,
} from "../shared/mod.ts";
import { AssetDir } from "./asset-dir.ts";

/**
 * The files one session has handed to the user (the `chat_attach` tool).
 *
 * Deliberately not the visual store, and not a second implementation of it:
 * both write into {@link AssetDir}, which is where the property that matters
 * lives (the store generates every name, so a name is the only address and a
 * path can never be forged). What this store adds is one kind of asset — any
 * file, with the original name kept so the download arrives as the file the
 * user expects.
 *
 * Two facts travel with the bytes and are stored beside them, not in a
 * database column: the name to offer on download, and the content type the
 * route answers with. A sidecar (`<name>.json`) keeps them, so a message
 * that names an attachment is enough to serve it — no row, no join, and a
 * store that survives a schema change.
 */
export class SessionAttachmentStore {
  readonly #dir: AssetDir;

  /** `root` is the directory the per-session directories are created under
   * (created on the first attachment, so a session that never sends a file
   * leaves nothing behind). */
  constructor(root: string) {
    this.#dir = new AssetDir(root);
  }

  /** Store `bytes` as a new attachment of `sessionId`, under `sourceName`
   * (the file's own name, used for the download and the card's label).
   * Throws when the file is over MAX_ATTACHMENT_BYTES or the session is at
   * MAX_ATTACHMENTS_PER_SESSION. Never truncates or renames the bytes: a
   * file too large is an error the agent has to solve (by sending a smaller
   * one), not a silently different file. */
  async put(
    sessionId: string,
    bytes: Uint8Array,
    sourceName: string,
  ): Promise<AttachmentRef> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment is too large: ${bytes.byteLength} bytes ` +
          `(limit ${MAX_ATTACHMENT_BYTES})`,
      );
    }
    const displayName = attachmentDisplayName(sourceName);
    // A name without a dot still gets served (as a download); the stored
    // name needs an extension to carry the content type, and "" is not one.
    const extension = extname(displayName).toLowerCase();
    let name: string;
    try {
      name = await this.#dir.write(
        sessionId,
        bytes,
        extension === "" ? ".bin" : extension,
        MAX_ATTACHMENTS_PER_SESSION,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(`holds ${MAX_ATTACHMENTS_PER_SESSION} assets`)
      ) {
        throw new Error(
          `This session already holds ${MAX_ATTACHMENTS_PER_SESSION} ` +
            "attachments; reuse one of them instead of sending another",
        );
      }
      throw error;
    }
    // The sidecar is what makes the download arrive under the name the user
    // knows. Written after the bytes, so an interrupted write leaves an
    // asset the route still serves (with its stored name) rather than a
    // sidecar pointing at nothing.
    await this.#dir.writeSidecar(
      sessionId,
      name,
      JSON.stringify({
        displayName: displayName.slice(0, MAX_ATTACHMENT_NAME_CHARS),
      }),
    );
    return {
      name,
      displayName,
      size: bytes.byteLength,
      inline: isInlineImageExtension(extension),
    };
  }

  /** The file an attachment name names, with what the route answers: the
   * content type and the download's file name. Undefined for an unknown or
   * malformed name, a name whose file was removed, or a session that never
   * attached anything — the shape is validated here so no caller has to. */
  async resolve(
    sessionId: string,
    name: string,
  ): Promise<
    { path: string; mimeType: string; downloadName: string } | undefined
  > {
    if (!ATTACHMENT_NAME.test(name)) return undefined;
    const path = await this.#dir.resolve(sessionId, name);
    if (path === undefined) return undefined;
    const extension = extname(name).toLowerCase();
    const sidecar = await this.#dir.readSidecar(sessionId, name);
    // A missing or unreadable sidecar is not an error: the file is still
    // there, and its stored name is a worse label than the original but a
    // truthful one.
    const downloadName = readDisplayName(sidecar) ?? name;
    return {
      path,
      mimeType: attachmentMimeType(extension),
      downloadName,
    };
  }

  /** Drop every attachment of a session (the session itself is gone).
   * No-op when the session never attached anything. */
  deleteSession(sessionId: string): Promise<void> {
    return this.#dir.deleteSession(sessionId);
  }
}

/** Stored attachment name: 12 hex characters and one extension. The store
 * generates it, so anything else is not an address this store hands out —
 * the same rule the visual store's names follow, and the only validator. */
const ATTACHMENT_NAME = /^[0-9a-f]{12}\.[a-z0-9]{1,16}$/;

/** The display name a sidecar carries, or undefined when it has none. A
 * malformed sidecar is ignored rather than failing the read: the bytes are
 * the file, and the label is a convenience. */
function readDisplayName(sidecar: string | undefined): string | undefined {
  if (sidecar === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(sidecar);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const displayName = (parsed as { displayName?: unknown }).displayName;
    return typeof displayName === "string" && displayName.length > 0
      ? displayName
      : undefined;
  } catch {
    return undefined;
  }
}

/** Most attachments one session may hold. A conversation sends a handful in
 * normal use; the cap only stops a loop from filling the disk. */
export const MAX_ATTACHMENTS_PER_SESSION = 200;

/** Directory (beside the database) that holds the sessions' attachments. */
export const ATTACHMENTS_DIR_NAME = ".lumisca-attachments";
