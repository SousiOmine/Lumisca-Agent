import { CoreError } from "../errors.ts";
import {
  type AttachmentRef,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CALL,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  TOOL_CHAT_ATTACH,
} from "../shared/mod.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import type { FileBackend } from "./file-backend.ts";
import { requireExistingFileWithSize } from "./resolve.ts";
import { array, object, string, type Tool, type ToolResult } from "./schema.ts";

const attachSchema = object({
  paths: array(
    string("Path of one file to send"),
    "Paths of existing files to send, in the same form the file tools " +
      "take (absolute, or relative to the working folder). Images are shown " +
      "inline; every other file is offered as a download. Capped at " +
      `${MAX_ATTACHMENTS_PER_CALL} files.`,
  ),
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
 * Read the files a call names into the session's store, with the limits one
 * call obeys.
 *
 * Shared by the two tools that hand files over (`chat_attach` in code mode,
 * `send_chat` in stella), so the bounds — one file's size, how many, how much
 * in total — are written once. Each of them is refused BEFORE the bytes are
 * transferred (the backend reports a size without reading), because a tool
 * that silently cut a file would hand the user a broken copy.
 */
export async function attachFiles(
  options: ChatAttachTarget & {
    files: FileBackend;
    /** The paths the model named (already validated as an array by the
     * tool's schema). */
    paths: readonly string[];
    signal?: AbortSignal;
  },
): Promise<AttachmentRef[]> {
  const { files, store, sessionId, paths, signal } = options;
  if (paths.length === 0) {
    throw new Error("Attach at least one file.");
  }
  if (paths.length > MAX_ATTACHMENTS_PER_CALL) {
    throw new Error(
      `You can attach up to ${MAX_ATTACHMENTS_PER_CALL} files in one call.`,
    );
  }

  const attachments: AttachmentRef[] = [];
  let total = 0;

  for (const requested of paths) {
    signal?.throwIfAborted();
    const { path, size } = await requireExistingFileWithSize(files, requested);
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `${requested} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} ` +
          "MiB; send it in a form that fits",
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
  return attachments;
}

/**
 * `chat_attach`: hand files to the user, without saying anything.
 *
 * Code mode only, and it is there because the reply's own text is what the
 * user reads: this tool attaches what cannot be said in words — the chart
 * the agent produced, the report it wrote, the log the user should keep. Left
 * to prose, the agent writes the path and the user has to go find the file;
 * the file is right there, so it is handed over instead.
 *
 * A stella conversation has `send_chat` instead: there the text is not shown
 * either, so "attach a file" and "say something" are one act.
 *
 * Cards are not part of this tool: the agent writes one into its reply
 * (shared/ui-markup), so a card needs no call of its own.
 *
 * The result carries the files in `details`, which is what the client draws
 * and what a reload re-draws (the transcript keeps the call).
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
      "Send files to the user beside your text: images are shown inline, " +
      "other files are offered as downloads. `paths` takes the same form as " +
      "the file tools (absolute, or relative to the working folder) and " +
      "each must exist. Up to " +
      `${MAX_ATTACHMENTS_PER_CALL} files per call, ` +
      `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB each and ` +
      `${MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MiB in total. Your ` +
      "text is already shown, so do not paste the file's content here as " +
      "well; say what the file is.",
    parameters: attachSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const paths = params.paths ?? [];
      if (paths.length === 0) {
        throw new CoreError("Attach at least one file.", "invalid");
      }
      const attachments = await attachFiles({
        files,
        store,
        sessionId,
        paths,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        content: [{
          type: "text",
          text: receipt(attachments.length),
        }],
        details: { attachments },
      };
    },
  };
}

/** What the model reads after the call. It says what was handed over, not
 * what it said: the reply's own text is shown separately, and repeating it
 * here would put the same words in the prompt twice. */
function receipt(files: number): string {
  return `Sent ${files === 1 ? "1 file" : `${files} files`} to the user.`;
}
