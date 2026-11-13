import { streamText } from "../ai/stream.ts";
import type { Api, Model, StreamFn } from "../ai/types.ts";
import { DEFAULT_LOCALE, type Locale } from "../shared/mod.ts";
import { outputLanguageSentence } from "../tools/language.ts";

/** Hard cap for a title. The prompt asks for this many characters and
 * cleanTitle enforces it (models occasionally ignore the number); declared
 * before the prompt so the text cannot name a different one. */
export const MAX_TITLE_CHARS = 30;

/** The instruction of the title request, sent as the opening lines of the
 * same user turn as the message it titles (see generateTitle).
 *
 * No worked example, deliberately. A sample in the prompt is what a small
 * model returns: measured with the fast model, the sample came back as the
 * title, or the model answered the task the sample describes and the reply
 * was cut to MAX_TITLE_CHARS — leaving a session named after the opening of
 * its first message instead of its topic.
 *
 * The cap is stated here even though cleanTitle enforces it (models ignore
 * the number), and the output language is the one rule the code cannot
 * derive. */
export function titleInstruction(language: Locale): string {
  return [
    `Write a title of at most ${MAX_TITLE_CHARS} characters for the task ` +
      "in <message>.",
    "Answer with the title alone.",
    outputLanguageSentence(language),
  ].join("\n");
}

/** Strip quotes, collapse whitespace, drop a closing sentence mark, and cap
 * the length of a generated title. Returns "" when nothing meaningful is
 * left. */
export function cleanTitle(raw: string): string {
  let title = raw.trim();
  if (
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1).trim();
  }
  title = title.replace(/\s+/g, " ").trim();
  // A title is a label, not a sentence: the terminator is dropped here
  // rather than asked for in the prompt (see titleInstruction).
  title = title.replace(/[.。．]$/, "").trim();
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
   * output. The session's language is part of the instruction: the tab must
   * read in the language the session answers in, whichever language the
   * first message happened to be written in. */
  async generateTitle(
    firstMessage: string,
    language: Locale = DEFAULT_LOCALE,
  ): Promise<string> {
    // The instruction and the message share one turn. Split across a system
    // prompt and a user turn they are two inputs, and the model can take
    // either for the task.
    const request =
      `${titleInstruction(language)}\n\n` +
      `<message>${firstMessage}</message>`;
    const text = await streamText(
      this.streamFn,
      this.model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: request }],
            timestamp: Date.now(),
          },
        ],
      },
      "title generation failed",
      {
        // One-off conversation: a fresh id per title request (session-affinity
        // gateways require a conversation id on every request).
        sessionId: crypto.randomUUID(),
        // No output cap of its own. Reasoning tokens are part of the
        // completion, and a reasoning model spends a few hundred of them
        // before the title starts (deepseek-v4.1-flash: ~250), so a cap sized
        // for the title alone returned an empty answer on every call — finish
        // "length", no text, and the session kept its provisional name. The
        // transport's cap (the model's documented output limit narrowed to
        // the compaction reserve) is the bound that does not starve it.
      },
    );
    const title = cleanTitle(text);
    if (!title) throw new Error("title generation returned no text");
    return title;
  }
}
