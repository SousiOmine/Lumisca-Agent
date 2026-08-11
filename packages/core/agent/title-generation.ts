import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** System prompt for the title model: a short, plain session title based
 * on the user's first message. */
const TITLE_SYSTEM_PROMPT =
  "You generate short titles for AI chat sessions. Based on the user's " +
  "first message, produce a concise title of at most 30 characters. " +
  "Output only the title — no quotes, no explanation, no trailing period.";

/** Hard cap for the title (the prompt asks for 30; models occasionally
 * ignore that). */
const MAX_TITLE_CHARS = 30;

/** Strip quotes, collapse whitespace, and cap the length of a generated
 * title. Returns "" when nothing meaningful is left. */
export function cleanTitle(raw: string): string {
  let title = raw.trim();
  if (
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1).trim();
  }
  title = title.replace(/\s+/g, " ").trim();
  return title.slice(0, MAX_TITLE_CHARS).trim();
}

/**
 * Generates a session title from the first user message using the fast
 * model. Called concurrently with the agent's first run; failures are the
 * caller's concern (the provisional name simply stays).
 */
export class TitleGenerator {
  constructor(
    private readonly model: Model<Api>,
    private readonly streamFn: StreamFn,
  ) {}

  /** Ask the fast model for a title. Throws on stream errors or empty
   * output. */
  async generateTitle(firstMessage: string): Promise<string> {
    const stream = await this.streamFn(this.model, {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: firstMessage }],
        timestamp: Date.now(),
      }],
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta;
      } else if (event.type === "error") {
        throw new Error(event.error.errorMessage ?? "title generation failed");
      }
    }
    const title = cleanTitle(text);
    if (!title) throw new Error("title generation returned no text");
    return title;
  }
}
