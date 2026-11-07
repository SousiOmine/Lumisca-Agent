import { CoreError } from "../errors.ts";
import {
  type AttachmentRef,
  CARD_HELP,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CALL,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  parseUiMarkup,
  TOOL_CHAT_ATTACH,
} from "../shared/mod.ts";
import type { SessionAttachmentStore } from "../session/attachments.ts";
import type { FileBackend } from "./file-backend.ts";
import { requireExistingFileWithSize } from "./resolve.ts";
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
  card: optional(string(`A card shown with the reply: ${CARD_HELP}`)),
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
 * either, so "attach a file" and "say something" are one act. Both tools take
 * the same `card` markup and write it under the same `details.card` key, so
 * one reader draws either.
 *
 * The result carries the files and the card in `details`, which is what the
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
      "Send files or a card to the user in this reply, beside your text: " +
      "images are shown inline, other files are offered as downloads, and " +
      "`card` is a small structured panel (a table, a metric, a flow, a " +
      "question). `paths` takes the same form as the file tools (absolute, " +
      "or relative to the working folder) and each must exist. Up to " +
      `${MAX_ATTACHMENTS_PER_CALL} files per call, ` +
      `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB each and ` +
      `${MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MiB in total. Your ` +
      "text is already shown, so do not paste the file's content here as " +
      "well; say what the file is.",
    parameters: attachSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const card = (params.card ?? "").trim();
      const paths = params.paths ?? [];
      if (card.length === 0 && paths.length === 0) {
        throw new CoreError("Send a file, a card, or both.", "invalid");
      }
      if (card.length > 0) {
        // Checked here, not in the browser: a card the server accepted must
        // draw, and the client only ever sees what this check let through.
        const parsed = parseUiMarkup(card);
        if (!parsed.ok) {
          throw new CoreError(
            `Invalid card markup: ${parsed.problem}`,
            "invalid",
          );
        }
      }
      const attachments = paths.length === 0 ? [] : await attachFiles({
        files,
        store,
        sessionId,
        paths,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        content: [{
          type: "text",
          text: receipt(card.length > 0, attachments.length),
        }],
        details: { attachments, card: card.length === 0 ? null : card },
      };
    },
  };
}

/** What the model reads after the call. It says what was handed over, not
 * what it said: the reply's own text is shown separately, and repeating it
 * here would put the same words in the prompt twice. */
function receipt(hasCard: boolean, files: number): string {
  const parts: string[] = [];
  if (files === 1) parts.push("1 file");
  else if (files > 1) parts.push(`${files} files`);
  if (hasCard) parts.push("a card");
  const what = parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Sent ${what} to the user.`;
}
