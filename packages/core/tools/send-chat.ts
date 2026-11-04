/**
 * `send_chat`: the one way a stella conversation's agent says anything.
 *
 * stella's agent is a model, and a model asked anything produces text. That
 * text is the model's working notes — it is how it thinks out loud, how it
 * reports a tool it just ran, how it explains what it is about to do — and
 * showing it made every turn a paragraph whether or not there was anything to
 * say. A routine that checks a log and finds nothing still pushed a "nothing
 * to report" message at the user.
 *
 * So the conversation shows what the agent SENT, and this tool is the only
 * way to send. A turn with nothing to report calls nothing and leaves the
 * screen as it was — the run ends, the typing indicator stops, and that is
 * the whole result. It is the same decision Terasuma makes with
 * `isDisplayPart`, moved to the server so a client never has to filter.
 *
 * The three things a message can carry are one call because they are one act:
 * the words, a card, and files. Splitting them (as `chat_ui` and
 * `chat_attach` did) meant an agent that wanted to hand over a picture with
 * one sentence made two calls and hoped the client drew them side by side.
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
  parseUiMarkup,
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

/**
 * The card language, documented where the model will read it. It has no other
 * reference: `chat_ui`'s description used to carry this text and it is the
 * only place the tags are explained, so it moves here whole.
 */
const CARD_HELP = [
  'card is one <Card title="..."> of UI markup with Text, List, Table, Flow, Choice and Form blocks inside it.',
  "<Text>paragraph</Text>; <List ordered><Item>one</Item></List>; <Table><Row><Cell>head</Cell><Cell>head</Cell></Row></Table> (the first row is the header).",
  '<Flow><Node id="a" shape="box|round|diamond|pill">Start</Node><Edge from="a" to="b" label="yes" dashed /></Flow>.',
  '<Choice multiple><Option description="why">Label</Option></Choice>; <Form submit="Send"><Field label="Name" type="text|number|select|checkbox" required placeholder="..."><Option>a choice for select</Option></Field></Form>.',
  "At most one Choice or Form per card. Write boolean attributes without a value, and attribute values in double quotes.",
  "Escape <, > and & in text as &lt;, &gt; and &amp;.",
  "Clicking an option sends its label as the user's next message; the user can click only after your turn ends, so end the turn after showing a question.",
].join(" ");

const sendChatSchema = object({
  text: optional(string(
    "What the user reads, in their language. Markdown is rendered. Omit it " +
      "when the message is a card or files only.",
  )),
  card: optional(string(`A card shown with the message: ${CARD_HELP}`)),
  paths: optional(array(
    string("Path of one file to send"),
    "Files to send with the message, in the same form the file tools take " +
      "(absolute, or relative to the working folder); each must exist. " +
      `Images are shown inline, other files are offered as downloads. Up to ` +
      `${MAX_ATTACHMENTS_PER_CALL} files, ` +
      `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB each.`,
  )),
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
 * The description is sent with every request of every stella turn, so it
 * states the contract of one call and nothing that changes: no counts that
 * differ per session, no examples that would have to be edited.
 */
const DESCRIPTION = [
  "Send the user a card, a file, or a progress note while long work is still running.",
  "Your reply is already the message the user reads; this is for what a reply cannot carry.",
  "One call is one message: the words (text), a card (card), and files (paths), in any combination; at least one of the three is required.",
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
export function createSendChatTool(options: SendChatOptions): Tool<
  typeof sendChatSchema
> {
  const { files, store, sessionId } = options;
  return {
    name: TOOL_SEND_CHAT,
    label: "Send Chat",
    description: DESCRIPTION,
    parameters: sendChatSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const text = (params.text ?? "").trim();
      const card = (params.card ?? "").trim();
      const paths = params.paths ?? [];
      if (text.length === 0 && card.length === 0 && paths.length === 0) {
        throw new CoreError(
          "Send something: text, a card, or files.",
          "invalid",
        );
      }
      if (card.length > 0) {
        // Validated here, not in the browser: a card the server accepted but
        // a client cannot read would be half a message. The parse is the same
        // one the client runs, so a markup that passes here always draws.
        const parsed = parseUiMarkup(card);
        if (!parsed.ok) {
          throw new CoreError(
            `Invalid card markup: ${parsed.problem}`,
            "invalid",
          );
        }
      }
      const attachments: AttachmentRef[] = paths.length === 0
        ? []
        : await attachFiles({
          files,
          store,
          sessionId,
          paths,
          ...(signal !== undefined ? { signal } : {}),
        });

      return {
        content: [{ type: "text", text: receipt({ text, card, attachments }) }],
        details: {
          text,
          card: card.length === 0 ? null : card,
          attachments,
        } satisfies ChatMessage,
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
  if (message.card !== null) parts.push("a card");
  if (message.attachments.length > 0) {
    parts.push(
      message.attachments.length === 1
        ? "1 file"
        : `${message.attachments.length} files`,
    );
  }
  const what = parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Sent ${what} to the user.`;
}
