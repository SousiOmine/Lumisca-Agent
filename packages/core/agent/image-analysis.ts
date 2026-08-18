import type {
  Api,
  ImageContent,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamText } from "./stream-text.ts";

/** System prompt for the image analysis model: it must produce a
 * description complete enough for a text-only model to work from. */
const ANALYSIS_SYSTEM_PROMPT =
  "You are an image analysis assistant. You describe images so that a " +
  "text-only AI can work from your description alone.\n\n" +
  "For each image:\n" +
  "- Transcribe all visible text verbatim (labels, error messages, code, " +
  "UI text, terminal output).\n" +
  "- Describe the layout and what the image shows.\n" +
  "- Note details relevant to coding or debugging (screenshots, diagrams).\n\n" +
  "Be precise and complete. Output only the description.";

/** Text block substituting an analyzed image in the LLM payload. */
function analysisTextBlock(description: string): TextContent {
  return { type: "text", text: `[image analysis]\n${description}` };
}

/**
 * Interprets images through a vision model on behalf of a text-only main
 * model. The agent passes the full history to `convertToLlm` on every
 * turn, so results are cached per image (by content hash) to avoid
 * re-analyzing the same image on every turn. Failures fall back to the
 * original content — the transcript is never modified, only the copy sent
 * to the LLM is rewritten.
 */
export class ImageAnalyzer {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly model: Model<Api>,
    private readonly streamFn: StreamFn,
  ) {}

  /** Replace the image blocks of a content array with their analysis text
   * (cached per image). Returns the original array when there are no
   * images or an analysis call fails. */
  async analyzeContent(
    content: Array<TextContent | ImageContent>,
  ): Promise<Array<TextContent | ImageContent>> {
    const images = content.filter((b): b is ImageContent => b.type === "image");
    if (images.length === 0) return content;

    const keys = await Promise.all(images.map((img) => this.keyOf(img)));
    const missing: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (!this.cache.has(keys[i]!)) missing.push(i);
    }
    if (missing.length > 0) {
      try {
        for (const i of missing) {
          const text = await this.analyze(images[i]!);
          this.cache.set(keys[i]!, text);
        }
      } catch {
        // Keep the original blocks on failure: the text-only model then
        // sees only the existing text markers (same as without the
        // analysis model). Never break the turn over an auxiliary call.
        return content;
      }
    }

    const out: Array<TextContent | ImageContent> = [];
    let imageIndex = 0;
    for (const block of content) {
      if (block.type === "image") {
        out.push(analysisTextBlock(this.cache.get(keys[imageIndex]!)!));
        imageIndex++;
      } else {
        out.push(block);
      }
    }
    return out;
  }

  /** One analysis call for a single image: streams the vision model and
   * accumulates the text deltas. Throws when the stream errors or returns
   * no text. */
  private async analyze(image: ImageContent): Promise<string> {
    // No reasoning option: the agent loop maps "off" to undefined the same
    // way, so this matches how the session's thinking level is passed.
    const text = await streamText(
      this.streamFn,
      this.model,
      {
        systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image in detail." },
            { type: "image", data: image.data, mimeType: image.mimeType },
          ],
          timestamp: Date.now(),
        }],
      },
      "image analysis failed",
    );
    const trimmed = text.trim();
    if (!trimmed) throw new Error("image analysis returned no text");
    return trimmed;
  }

  /** Cache key of an image: SHA-256 over the base64 payload. */
  private async keyOf(image: ImageContent): Promise<string> {
    const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
