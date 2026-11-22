/**
 * The message one prompt path builds, assembled in one place.
 *
 * Two paths build a prompt message (a fire-and-forget delivery, which has to
 * decide its `steered` stamp before waiting on a rewind, and the run every
 * other path takes). They used to assemble the content, the model-only text
 * and the mode variant separately, so a change to any of the three had to be
 * made twice. The envelope carries what the caller knows and this module
 * answers "what is the message", including the timestamp, which must follow
 * the message before it (see Agent.nextTimestamp).
 */

import type {
  AgentMessage,
  ImageContent,
  TextContent,
} from "../domain/message.ts";
import { buildModeMessage, type ModePrompt } from "../domain/mode-message.ts";
import { type PromptFileRef, textWithFileNotice } from "../shared/mod.ts";

/** `text` with `part` after it, separated by a blank line; undefined when
 * there is nothing to append (so a message without a model-only part keeps
 * `modelContent` unset and its content is its identity). */
function withTrailingPart(
  text: string,
  part: string | undefined,
): string | undefined {
  if (part === undefined || part.length === 0) {
    return text.length === 0 ? undefined : text;
  }
  return text.length === 0 ? part : `${text}\n\n${part}`;
}

/** What a prompt path knows about the message it is about to deliver. */
export interface PromptEnvelope {
  text: string;
  images?: ImageContent[];
  /** Whether this prompt joins the run that is already active (see
   * SessionRuns.joinsActiveRun). The delivery decision is stamped on the
   * message, because the UI keeps a steered prompt inside that run's turn. */
  steered: boolean;
  /** A mode prompt: the conversation draws the short text and the badge, and
   * the model reads the full prompt. */
  mode?: ModePrompt;
  /** The routine whose run this is (stamped so its stop button only
   * interrupts its own run). */
  routine?: string;
  /** Files the user attached to this prompt (already in the machine). */
  files?: PromptFileRef[];
  /** Text only the MODEL reads, after the visible text. */
  modelOnly?: string;
}

/** Build the message one prompt path delivers. */
export function buildPromptEnvelope(
  envelope: PromptEnvelope,
  timestamp: number,
): AgentMessage {
  const { text, images, steered, mode, routine, files, modelOnly } = envelope;
  if (mode !== undefined) {
    return buildModeMessage(mode, text, images ?? [], timestamp, steered);
  }
  const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
  if (images !== undefined && images.length > 0) content.push(...images);
  // The files already sit in the machine; this record is what the
  // conversation draws under the bubble. Their paths are addressed to the
  // MODEL, so they travel as `modelContent` and never reach the screen: the
  // user wrote a sentence, and the sentence is what they should see.
  //
  // A routine's silence guidance belongs there for the same reason: it is
  // addressed to the model, and a bubble that told the user "if there is
  // nothing to report, stay silent" is prose about the run rather than the
  // run's instruction.
  const modelContent = withTrailingPart(
    textWithFileNotice(text, files ?? []),
    modelOnly,
  );
  return {
    role: "user",
    content,
    ...(modelContent !== undefined ? { modelContent } : {}),
    ...(steered ? { steered } : {}),
    ...(routine !== undefined && routine !== "" ? { routine } : {}),
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    timestamp,
  };
}
