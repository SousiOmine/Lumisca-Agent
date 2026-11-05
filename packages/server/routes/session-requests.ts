/**
 * The request bodies a prompt, a model switch, a rewind and an ask share.
 *
 * Both prompt surfaces read the same shape, with the same bounds and the same
 * "the text may be empty when a file is attached" rule (see
 * routes/conversation.ts). One parser means an attachment cannot be accepted
 * on one surface and silently dropped on the other — which is what a second,
 * narrower parser had become.
 */
import { base64ToBytes } from "@lumisca/core";
import { bytesToBase64 } from "../../core/base64.ts";
import { prepareStoredImage } from "../../core/media/stored-image.ts";
import {
  MAX_PROMPT_FILE_BASE64_LENGTH,
  MAX_PROMPT_FILES,
  MAX_PROMPT_TEXT_LENGTH,
  stripDataUrlHeader,
} from "@lumisca/core/shared";
import type { AskAnswer, ImageContent, ModePrompt } from "@lumisca/core";

export type { AskAnswer, ModePrompt };
import { AppError, requireNonEmptyString } from "./util.ts";

/** Decode a base64 payload that may still carry a data-URL header (a
 * `FileReader` result). A malformed payload describes the request, so it is a
 * 400 — never a store-level failure. */
function decodeBase64Payload(data: string, what: string): Uint8Array {
  try {
    return base64ToBytes(stripDataUrlHeader(data));
  } catch {
    throw new AppError(`${what} data is not valid base64`, 400);
  }
}

/** One attached file as the browser sends it (the bytes base64-encoded, the
 * name the user knows it by). */
interface PromptFileBody {
  name?: unknown;
  data?: unknown;
}

export interface PromptBody {
  text?: unknown;
  images?: unknown;
  files?: unknown;
  mode?: unknown;
}

interface AnswerBody {
  toolCallId?: unknown;
  answers?: unknown;
}

export function parseAnswerBody(body: unknown): {
  toolCallId: string;
  answers: AskAnswer[];
} {
  const answerBody = (body ?? {}) as AnswerBody;
  const toolCallId = requireNonEmptyString(
    answerBody.toolCallId,
    "toolCallId (string)",
  );
  if (!Array.isArray(answerBody.answers) || answerBody.answers.length === 0) {
    throw new AppError("answers (array) is required", 400);
  }
  const answers: AskAnswer[] = [];
  for (const item of answerBody.answers as Array<Record<string, unknown>>) {
    const { id, values } = item;
    if (
      typeof id !== "string" ||
      !Array.isArray(values) ||
      values.some((v) => typeof v !== "string")
    ) {
      throw new AppError(
        "each answer must have an `id` (string) and `values` (array of strings)",
        400,
      );
    }
    answers.push({ id, values: values as string[] });
  }
  return { toolCallId, answers };
}

/** Validate a prompt request body; `images` are base64 data + mimeType,
 * converted into the content blocks the agent expects. `text` may be
 * empty when at least one image is attached (image-only prompts). */
export function parsePromptBody(body: PromptBody): {
  text: string;
  images?: ImageContent[];
  files?: { name: string; bytes: Uint8Array }[];
  mode?: ModePrompt;
} {
  // Parse optional mode metadata.
  let mode: ModePrompt | undefined;
  if (body.mode !== undefined) {
    if (typeof body.mode !== "object" || body.mode === null) {
      throw new AppError("mode must be an object", 400);
    }
    const m = body.mode as Record<string, unknown>;
    if (
      typeof m.modeId !== "string" ||
      typeof m.optionId !== "string" ||
      typeof m.modeLabel !== "string" ||
      typeof m.shortText !== "string"
    ) {
      throw new AppError(
        "mode must have modeId, optionId, modeLabel, and shortText (strings)",
        400,
      );
    }
    mode = {
      modeId: m.modeId,
      optionId: m.optionId,
      modeLabel: m.modeLabel,
      shortText: m.shortText,
    };
  }
  const images: ImageContent[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > MAX_PROMPT_FILES) {
      throw new AppError(
        `images must be an array of at most ${MAX_PROMPT_FILES} items`,
        400,
      );
    }
    for (const item of body.images as Array<Record<string, unknown>>) {
      const { data, mimeType } = item;
      if (
        typeof data !== "string" ||
        typeof mimeType !== "string" ||
        !mimeType.startsWith("image/")
      ) {
        throw new AppError(
          "each image must have a base64 `data` string and an `image/*` mimeType",
          400,
        );
      }
      if (data.length > MAX_PROMPT_FILE_BASE64_LENGTH) {
        throw new AppError(
          "image exceeds the size limit (15MB binary)",
          400,
        );
      }
      images.push({ type: "image", data, mimeType });
    }
  }
  // Files the user attached: written into the machine by the caller (this
  // parser only owns the wire shape), so what is bounded here is what the
  // transfer can carry — not what the machine will store.
  const files: { name: string; bytes: Uint8Array }[] = [];
  if (body.files !== undefined) {
    if (!Array.isArray(body.files) || body.files.length > MAX_PROMPT_FILES) {
      throw new AppError(
        `files must be an array of at most ${MAX_PROMPT_FILES} items`,
        400,
      );
    }
    for (const item of body.files as PromptFileBody[]) {
      const { name, data } = item;
      if (typeof data !== "string" || typeof name !== "string") {
        throw new AppError(
          "each file must have a `name` and a base64 `data` string",
          400,
        );
      }
      if (data.length > MAX_PROMPT_FILE_BASE64_LENGTH) {
        throw new AppError("file exceeds the size limit (15MB binary)", 400);
      }
      files.push({
        name,
        bytes: decodeBase64Payload(data, "file"),
      });
    }
  }
  const text = body.text === undefined ? "" : body.text;
  if (
    typeof text !== "string" ||
    (text.length === 0 && images.length === 0 && files.length === 0)
  ) {
    throw new AppError("text (string) is required", 400);
  }
  // A paste that would fill the context in one turn is refused here rather
  // than compacted away immediately (see MAX_PROMPT_TEXT_LENGTH).
  if (text.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new AppError(
      `text is longer than ${MAX_PROMPT_TEXT_LENGTH} characters`,
      400,
    );
  }
  return {
    text,
    images: images.length > 0 ? images : undefined,
    files: files.length > 0 ? files : undefined,
    mode,
  };
}

/**
 * The images a prompt carries, as the transcript will keep them.
 *
 * A picture attached to a prompt is a byte block in the message, and the
 * message is the database: a phone photo is 15 MB of bytes (20 MB of base64)
 * and one prompt may carry eight of them. The model cannot use more than its
 * own budget anyway (see core/media/stored-image.ts), so the copy that is
 * stored is bounded to it. stella takes the same pictures, but writes them
 * into the machine instead of the message — bounding them here keeps that
 * copy small too.
 *
 * Both prompt surfaces call this after `parsePromptBody`, so a size limit
 * cannot apply to one of them. A payload that is not base64 is a 400: the
 * message stores bytes, and there is nothing to store for text that is not
 * bytes.
 */
export async function preparePromptImages(
  images: readonly ImageContent[] | undefined,
): Promise<ImageContent[] | undefined> {
  if (images === undefined || images.length === 0) return undefined;
  const prepared: ImageContent[] = [];
  for (const image of images) {
    const stored = await prepareStoredImage(
      decodeBase64Payload(image.data, "image"),
      image.mimeType,
    );
    prepared.push(
      stored.changed
        ? {
          type: "image",
          data: bytesToBase64(stored.bytes),
          mimeType: stored.mimeType,
        }
        : image,
    );
  }
  return prepared;
}

/** The slice of the core these routes need (interface segregation). */
