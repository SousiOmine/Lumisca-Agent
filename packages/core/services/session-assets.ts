import { extname } from "node:path";
import { CoreError } from "../errors.ts";
import type { PromptFileRef } from "../shared/mod.ts";
import { RASTER_IMAGE_MIME_BY_EXTENSION } from "../shared/mod.ts";
import {
  MAX_PROMPT_IMAGE_BYTES,
  readUpload,
  saveUploads,
  type UploadFile,
} from "../vm/uploads.ts";
import type { SessionServiceDeps } from "./session-deps.ts";

type Deps = Pick<
  SessionServiceDeps,
  "sessions" | "visuals" | "attachments" | "stella"
>;

/**
 * The files that belong to a session: the images it published for its replies
 * and the files an agent handed to the user (both resolved by name for the
 * asset routes), plus the files a prompt carries into the stella machine.
 *
 * Two directions of travel: published assets are read from a store beside the
 * database, prompt uploads are written into the machine. Both are tied to the
 * session, which is why deleting a session drops the stores too (see
 * SessionLifecycle.deleteSession).
 */
export class SessionAssets {
  constructor(private readonly deps: Deps) {}

  /** The file one of a session's published visuals names. */
  resolveSessionVisual(
    sessionId: string,
    name: string,
  ): Promise<{ path: string; mimeType: string } | undefined> {
    return this.deps.visuals.resolve(sessionId, name);
  }

  /** The file one of a session's attachments names. */
  resolveSessionAttachment(
    sessionId: string,
    name: string,
  ): Promise<
    { path: string; mimeType: string; downloadName: string } | undefined
  > {
    return this.deps.attachments.resolve(sessionId, name);
  }

  /** Put a prompt's attached files into the machine. */
  async savePromptUploads(
    id: string,
    uploads: readonly UploadFile[],
  ): Promise<PromptFileRef[]> {
    const session = this.deps.sessions.get(id);
    if (session === undefined) {
      throw new CoreError(`Session not found: ${id}`, "not_found");
    }
    if (session.stella !== true || session.agentId === undefined) {
      throw new CoreError(
        "Attached files can only be sent to a stella conversation: this " +
          "session's tools work on the user's own folders, so there is " +
          "nowhere to put them",
        "invalid",
      );
    }
    const exec = this.deps.stella.exec();
    if (exec === undefined) {
      throw new CoreError(
        "The machine is not available, so the files cannot be put in it",
        "unavailable",
      );
    }
    return await saveUploads(uploads, { exec, agentId: session.agentId });
  }

  /** Read one file a prompt brought back out of the machine. */
  async resolvePromptUpload(
    agentId: string,
    ref: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    const exec = this.deps.stella.exec();
    const execBytes = this.deps.stella.execBytes();
    if (exec === undefined || execBytes === undefined) {
      throw new CoreError(
        "The machine is not available, so the file cannot be read",
        "unavailable",
      );
    }
    const read = await readUpload(exec, execBytes, {
      agentId,
      ref,
      maxBytes: MAX_PROMPT_IMAGE_BYTES,
    });
    if (read === undefined) return undefined;
    // The type comes from the extension the store chose, not from the bytes:
    // the name is what the store generated, and a prompt picture was stored
    // under its own type's extension (see the prompt route).
    const extension = extname(read.name).toLowerCase();
    const mimeType =
      RASTER_IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
    return { bytes: read.bytes, mimeType };
  }
}
