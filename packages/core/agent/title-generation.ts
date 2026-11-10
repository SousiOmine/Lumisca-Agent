import type { Api, Model } from "../ai/types.ts";
import type { StreamFn } from "../ai/types.ts";
import { streamText } from "../ai/stream.ts";
import { DEFAULT_LOCALE, type Locale } from "../shared/mod.ts";
import { outputLanguageSentence } from "../tools/language.ts";

/** Hard cap for a title. The prompt asks for this many characters and
 * cleanTitle enforces it (models occasionally ignore the number); declared
 * before the prompt so the text cannot name a different one. */
export const MAX_TITLE_CHARS = 30;

/** One worked example per language. A small model copies the shape it saw
 * last, so the sample IS the format — and it is written in the title's own
 * language, because an English sample beside "Write the answer in Japanese"
 * pulls the model back to English. A new locale must add its entry here
 * (`Record<Locale, …>` fails to compile without one). */
const TITLE_EXAMPLE: Record<Locale, { message: string; title: string }> = {
  en: {
    message: "the login button is broken on mobile, can you fix?",
    title: "Fix mobile login button",
  },
  ja: {
    message: "スマホでログインボタンが押せないので直して",
    title: "スマホのログイン不具合を修正",
  },
};

/** System prompt of the title model: positive rules only, and only the ones
 * cleanTitle does not already guarantee. It strips quotes, a closing
 * sentence mark and anything past MAX_TITLE_CHARS, so a "no quotes, no
 * trailing period" clause here would spend a small model's constraint
 * budget on rules the code keeps anyway. */
export function titleSystemPrompt(language: Locale): string {
  const example = TITLE_EXAMPLE[language];
  return `Write a title of at most ${MAX_TITLE_CHARS} characters for the ` +
    `task in <message>.\nAnswer with the title alone.\n\n` +
    `<message>${example.message}</message>\n${example.title}`;
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
  // rather than asked for in the prompt (see titleSystemPrompt).
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
   * output. The session's language is appended to the prompt: the tab must
   * read in the language the session answers in, whichever language the
   * first message happened to be written in. */
  async generateTitle(
    firstMessage: string,
    language: Locale = DEFAULT_LOCALE,
  ): Promise<string> {
    const text = await streamText(
      this.streamFn,
      this.model,
      {
        systemPrompt: `${titleSystemPrompt(language)} ${
          outputLanguageSentence(language)
        }`,
        messages: [{
          role: "user",
          content: [{ type: "text", text: firstMessage }],
          timestamp: Date.now(),
        }],
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
