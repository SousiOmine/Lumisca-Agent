/**
 * `send_chat`: what a stella conversation's agent sends BESIDE its reply.
 *
 * The assistant's final text is already the reply (see
 * agent/stella-stream.ts): a model asked anything produces text, and a turn
 * that ends without a tool call is that answer. So this tool carries what a
 * reply cannot — files, or a progress message while a long turn is still
 * running — and a turn that has nothing to add writes `NO_RESPONSE`
 * instead.
 *
 * It used to be the only way to speak, and a forgotten call left the user
 * waiting for an answer that never came. The default is now the other way
 * round: forgetting this call still says something, and silence is the
 * deliberate act.
 *
 * The two things a message can carry are one call because they are one act:
 * the words and files. Splitting them (as `chat_attach` did) meant an agent
 * that wanted to hand over a picture with one sentence made two calls and
 * hoped the client drew them side by side.
 *
 * A card is NOT here: the agent writes it into its reply (see
 * shared/ui-markup), so a message that shows a table or asks a question needs
 * no call at all.
 *
 * What the model reads back is a receipt, not the message: see the `execute`
 * comment.
 */
import { CoreError } from "../errors.ts";
import {
  type AttachmentRef,
  type ChatMessage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CALL,
  TOOL_SEND_CHAT,
} from "../shared/mod.ts";
import { attachFiles, type ChatAttachTarget } from "./attach.ts";
import type { FileBackend } from "./file-backend.ts";
import {
  array,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "./schema.ts";

const sendChatSchema = object({
  text: optional(
    string(
      "What the user reads, in their language. Markdown is rendered. Omit it " +
        "when the message is files only.",
    ),
  ),
  paths: optional(
    array(
      string("Path of one file to send"),
      "Files to send with the message, in the same form the file tools take " +
        "(absolute, or relative to the working folder); each must exist. " +
        `Images are shown inline, other files are offered as downloads. Up to ` +
        `${MAX_ATTACHMENTS_PER_CALL} files, ` +
        `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB each.`,
    ),
  ),
});

/** What the tool needs: the session's files to read and its store to keep
 * what it sends. */
export interface SendChatOptions extends ChatAttachTarget {
  files: FileBackend;
}

/** The part of {@link SendChatOptions} a tool set carries (the file backend
 * is the set's own, so it is filled in there). */
export type SendChatTarget = ChatAttachTarget;

/**
 * The description is sent with every request of every turn, so it states the
 * contract of one call and nothing that changes: no counts that differ per
 * session, no examples that would have to be edited.
 *
 * The first line is the one that changes behaviour, and it is ordered rather
 * than conditioned. "Send a note while long work is running" (what this used
 * to say) leaves the model to decide when a wait has become long, and the
 * decision it makes is "after I have something to say" — which is the end of
 * the run, and the message the user gets instead of an answer during it. A
 * reader who watches forty minutes of tool rows has been told nothing, and
 * cannot tell a working agent from a stuck one. So the instruction is to
 * speak FIRST, and it names what makes the work long (reading, building,
 * testing, waiting) so the decision does not depend on a feeling about time.
 */
const DESCRIPTION = [
  "Send the user a note BEFORE starting work that will take more than a moment — reading many files, a build, tests, a search, or anything you expect to run for a while — saying what you are about to do and what you are looking for.",
  "Until you do, the conversation shows only a timer and tool names: the user cannot see your plan, cannot tell progress from a hang, and cannot correct your direction before you have spent the time.",
  "Send another when the picture changes (what you found, that the approach is wrong, that the work is longer than you said). Your reply at the end is still the answer.",
  "One call is one message: the words (text) and files (paths), in any combination; at least one of the two is required. A card is not sent by this tool — write it into your reply instead.",
  "A run with nothing to report replies with exactly NO_RESPONSE (see the system prompt).",
].join(" ");

/**
 * Build `send_chat`.
 *
 * The result is deliberately a receipt: `content` (what the MODEL reads on
 * its next turn) says only what was sent, while the message itself travels in
 * `details`, which the model never sees (ai/tool-envelope.ts) and the
 * conversation draws. Both halves matter:
 *
 * - the message is already in the transcript as this call's arguments, so
 *   repeating it in the result would put every word in the prompt twice, and
 *   a conversation that lives for years pays that on every request;
 * - the model can still read what it sent — from the call above — and, once
 *   a compaction checkpoint has replaced that span, from `history_search`
 *   (session/prune.ts keeps this result for exactly that).
 */
export function createSendChatTool(
  options: SendChatOptions,
): Tool<typeof sendChatSchema> {
  const { files, store, sessionId } = options;
  return {
    name: TOOL_SEND_CHAT,
    label: "Send Chat",
    description: DESCRIPTION,
    parameters: sendChatSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const text = (params.text ?? "").trim();
      const paths = params.paths ?? [];
      if (text.length === 0 && paths.length === 0) {
        throw new CoreError("Send something: text or files.", "invalid");
      }
      const attachments: AttachmentRef[] =
        paths.length === 0
          ? []
          : await attachFiles({
              files,
              store,
              sessionId,
              paths,
              ...(signal !== undefined ? { signal } : {}),
            });

      return {
        content: [{ type: "text", text: receipt({ text, attachments }) }],
        details: { text, attachments } satisfies ChatMessage,
      };
    },
  };
}

/** What the model reads after sending: a receipt, and the one thing the
 * result cannot say by itself — that the words it wrote around the call are
 * not part of the message. */
function receipt(message: ChatMessage): string {
  const parts: string[] = [];
  if (message.text.length > 0) parts.push("the message");
  if (message.attachments.length > 0) {
    parts.push(
      message.attachments.length === 1
        ? "1 file"
        : `${message.attachments.length} files`,
    );
  }
  const what =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Sent ${what} to the user.`;
}
