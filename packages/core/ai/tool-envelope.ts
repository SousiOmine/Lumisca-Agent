/** How a tool result reaches the model: the text it reads, the images it may
 * look at, and the details kept out of both. Split from the transport so the
 * shapes can be read (and tested) without a provider. */

export interface ToolImage {
  data: string;
  mimeType: string;
}

/** What a Lumisca tool's `execute` hands to the AI SDK's tool loop: the
 * transcript text, the structured details the UI reads (the `+3 -2` diff
 * badge), and the images the tool returned. The SDK carries the whole
 * object on its `tool-result` part; the transport then splits it for its
 * two audiences — details for the UI, text and images for the model (see
 * toModelOutput and toCoreMessages). */
export interface ToolOutput {
  text: string;
  details: Record<string, unknown>;
  images: readonly ToolImage[];
}

/** Read a `tool-result` part's output as {@link ToolOutput}: our own
 * envelope, or the text of any other result (a provider-executed or
 * test-double result carries neither details nor images). */
export function readToolOutput(output: unknown): ToolOutput {
  if (typeof output === "object" && output !== null) {
    const candidate = output as {
      text?: unknown;
      details?: unknown;
      images?: unknown;
    };
    if (
      typeof candidate.text === "string" &&
      typeof candidate.details === "object" &&
      candidate.details !== null
    ) {
      return {
        text: candidate.text,
        details: candidate.details as Record<string, unknown>,
        images: toolImages(candidate.images),
      };
    }
  }
  return { text: outputText(output), details: {}, images: [] };
}

/** The images of a tool result envelope, filtered to the well-formed ones:
 * a block without base64 data or without a media type would only fail
 * deeper in the provider (or render as a broken `<img>`). */
export function toolImages(value: unknown): ToolImage[] {
  if (!Array.isArray(value)) return [];
  const images: ToolImage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const image = entry as { data?: unknown; mimeType?: unknown };
    if (
      typeof image.data !== "string" || image.data === "" ||
      typeof image.mimeType !== "string" || image.mimeType === ""
    ) {
      continue;
    }
    images.push({ data: image.data, mimeType: image.mimeType });
  }
  return images;
}

/** Normalize a tool result's details to a plain record: a tool that
 * reported none (or something other than an object) gets `{}` instead, so
 * the transcript never carries a non-record. */
export function toolDetails(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The model-facing form of a tool result for the SDK's own step
 * continuation: the text alone, or the SDK's `content` output carrying the
 * images as file parts (the shape every provider's tool-result conversion
 * reads). The SDK runs this conversion for every tool call (it builds the
 * step's response messages from it); the next request Lumisca sends is not
 * that object but the transport's own conversion (see toCoreMessages), so
 * this only has to reflect the tool's result faithfully. */
export function toolModelOutput(output: ToolOutput) {
  if (output.images.length === 0) {
    return { type: "text" as const, value: output.text };
  }
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: output.text },
      ...output.images.map(imageFilePart),
    ],
  };
}

/** One image block as the SDK's file part. This is the current image shape
 * (`{ type: "image" }` is deprecated and logs a warning on every request
 * that carries an image); the tagged `data` payload keeps the explicit
 * media type instead of a `data:` URL the provider has to parse. */
/** The tool-result output for one provider: the text alone, or the SDK's
 * `content` output when that provider's tool message can carry the images
 * (see {@link toolResultTakesImages}). */
export function toolResultOutput(
  value: string,
  images: readonly ToolImage[],
  isError: boolean,
  takesImages: boolean,
) {
  if (isError) return { type: "error-text" as const, value };
  if (images.length === 0 || !takesImages) {
    return { type: "text" as const, value };
  }
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: value },
      ...images.map(imageFilePart),
    ],
  };
}

/** Render an SDK tool `output` (whatever the execute function returned)
 * as the transcript/display text. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null) {
    const o = output as { type?: unknown; value?: unknown; text?: unknown };
    if (typeof o.value === "string") return o.value;
    if (typeof o.text === "string" && typeof o.type === "string") {
      return o.text;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  if (output === undefined || output === null) return "Tool completed.";
  return String(output);
}

/** One image as the provider's file part (the assistant and user sides share
 * the shape). */
export function imageFilePart(image: { data: string; mimeType: string }) {
  return {
    type: "file" as const,
    mediaType: image.mimeType,
    data: { type: "data" as const, data: image.data },
  };
}
