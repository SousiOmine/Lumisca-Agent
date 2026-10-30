import {
  type AttachmentRef,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CALL,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  TOOL_CHAT_ATTACH,
} from "../shared/mod.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import type { FileBackend } from "./file-backend.ts";
import { requireExistingFile } from "./resolve.ts";
import {
  array,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";

const attachSchema = object({
  paths: optional(array(
    string("Path of one file to send"),
    "Paths of existing files to send, in the same form the file tools " +
      "take (absolute, or relative to the working folder). Images are shown " +
      "inline; every other file is offered as a download. Capped at " +
      `${MAX_ATTACHMENTS_PER_CALL} files.`,
  )),
});

/** What the tool needs to read files and where to put them. */
export interface ChatAttachOptions {
  /** The session's file backend: the workspace's files in code mode, the
   * machine's files in stella. Paths are resolved against it, so what the
   * agent may attach is exactly what it may read. */
  files: FileBackend;
  /** Where the bytes are kept (the session's own store, never the user's
   * files). */
  store: SessionAttachmentStore;
  sessionId: string;
}

/** The part of {@link ChatAttachOptions} a tool set carries (the backend is
 * the set's own, so it is filled in there). */
export type ChatAttachTarget = Omit<ChatAttachOptions, "files">;

/**
 * `chat_attach`: hand files to the user.
 *
 * The reply's text is already the answer; this tool exists for what cannot
 * be said in words — the chart the agent produced, the report it wrote, the
 * log the user should keep. Left to prose, the agent writes the path and the
 * user has to go find the file; the file is right there, so it is handed
 * over instead.
 *
 * The result carries the attachment list in `details`, which is what the
 * client draws and what a reload re-draws (the transcript keeps the call).
 * The bytes are copied into the session's store, so what the user sees keeps
 * showing what was sent even after the original file changes.
 */
export function createChatAttachTool(
  options: ChatAttachOptions,
): Tool<typeof attachSchema> {
  const { files, store, sessionId } = options;
  return {
    name: TOOL_CHAT_ATTACH,
    label: "Chat Attach",
    description:
      "Send files to the user in this reply: images are shown inline, " +
      "other files are offered as downloads. `paths` takes the same form as " +
      "the file tools (absolute, or relative to the working folder) and " +
      `each must exist. Up to ${MAX_ATTACHMENTS_PER_CALL} files per call, ` +
      `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB each and ` +
      `${MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MiB in total. Your ` +
      "text is already shown, so do not paste the file's content here as " +
      "well; say what the file is.",
    parameters: attachSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const paths = params.paths ?? [];
      if (paths.length === 0) {
        throw new Error("Attach at least one file.");
      }
      if (paths.length > MAX_ATTACHMENTS_PER_CALL) {
        throw new Error(
          `You can attach up to ${MAX_ATTACHMENTS_PER_CALL} files in one ` +
            "call.",
        );
      }

      const attachments: AttachmentRef[] = [];
      let total = 0;

      for (const requested of paths) {
        signal?.throwIfAborted();
        const path = await requireExistingFile(files, requested);
        const stat = await files.stat(path);
        // The backend reports the size without reading, so an oversized
        // file is refused before it is transferred — a tool that silently
        // cut a file would hand the user a broken copy.
        if ((stat?.size ?? 0) > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `${requested} is larger than ${
              MAX_ATTACHMENT_BYTES / (1024 * 1024)
            } MiB; send it in a form that fits`,
          );
        }
        const { bytes } = await files.readHead(path, MAX_ATTACHMENT_BYTES);
        total += bytes.byteLength;
        if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
          throw new Error(
            `The files total more than ${
              MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)
            } MiB; send fewer of them`,
          );
        }
        attachments.push(await store.put(sessionId, bytes, requested));
      }

      return {
        content: [{
          type: "text",
          text: attachments.length === 1
            ? "Sent 1 file to the user."
            : `Sent ${attachments.length} files to the user.`,
        }],
        details: { attachments },
      };
    },
  };
}
