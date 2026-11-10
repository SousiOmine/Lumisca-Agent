/**
 * What a `send_chat` call sent, as the conversation draws it.
 *
 * The tool carries two things and they reach the user together: the words
 * and files. A stella conversation shows them beside the agent's own reply
 * (the final text of its turn; see agent/stella-stream.ts), so this is the
 * shape the projection reads for what a call sent, and the shape a client
 * draws. A card is not here: it is part of the reply's own text (see
 * ui-markup/segments.ts).
 *
 * The values live in the tool result's `details`, never in its `content`:
 * `content` is what the MODEL reads on its next turn, and repeating the
 * message there would put the same words in the transcript twice (the tool
 * call's arguments already carry them). `details` is what the UI reads and
 * what nothing else touches — see ai/tool-envelope.ts.
 */
import { type AttachmentRef, attachmentsOfDetails } from "./attachments.ts";

/** One message an agent sent: the words and the files. Every field may be
 * empty — a reply that was only a picture is as legitimate as one that was
 * only a sentence. */
export interface ChatMessage {
  /** The words the user reads ("" when the call sent only files). */
  text: string;
  /** The files the call sent, in the order the model named them. */
  attachments: AttachmentRef[];
}

/** Read a `send_chat` result's `details` as a {@link ChatMessage}, or
 * undefined when they are not the shape this build wrote (a stored result
 * from another build, a hand-edited row, a result of some other tool). One
 * parser, used by the server's projection and by the browser, so the two
 * cannot draw different messages from the same row. */
export function chatMessageOfDetails(
  details: unknown,
): ChatMessage | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as { text?: unknown };
  if (typeof record.text !== "string") return undefined;
  return {
    text: record.text,
    attachments: attachmentsOfDetails(details),
  };
}
