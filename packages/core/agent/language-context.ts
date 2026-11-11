/**
 * The output-language context provider: publishes the language the session
 * answers in as a durable transcript message instead of baking it into the
 * system prompt.
 *
 * The language is a SETTING — the settings dialog writes it — so it can
 * change while a session lives. In the prompt it froze at session creation
 * (the prompt is a snapshot), which meant switching the app to English left
 * every open session answering in the old language until a new one was
 * made; an agent that noticed the user now writing English had a rule it
 * could not follow. Changing the prompt instead is not an option: the
 * provider's whole cached prefix would be dropped on every switch (see
 * ai/context-providers.ts).
 *
 * As a context message the fact is paid once, appended (never inserted), and
 * republished only when the language actually changed — the same shape as
 * the date (agent/date-context.ts) and the model (agent/model-context.ts).
 *
 * The sub-agents of a session read the same setting on every open (see
 * TaskHub.setLanguage), so this is also what makes a sub-agent's report come
 * back in the language the main agent is speaking.
 */

import type {
  ContextProvider,
  ContextUpdate,
} from "../ai/context-providers.ts";
import type { Locale } from "../shared/mod.ts";
import { languageName } from "../tools/language.ts";

/** Provider name of the output-language context. */
export const LANGUAGE_PROVIDER = "language";

export interface LanguageContextOptions {
  /** The language the session should answer in now, read before every run
   * so a setting change reaches the next request. */
  language: () => Locale;
}

interface LanguageState {
  locale: string;
}

function localeOf(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const locale = (state as LanguageState).locale;
  return typeof locale === "string" ? locale : undefined;
}

/** The sentence the prompt used to carry. One rule, no examples: what to do
 * (answer in this language) and what not to do (follow the language of the
 * user's message, tool output, files or web pages) — the second half is the
 * part a model gets wrong on its own. */
export function languageInstruction(locale: Locale): string {
  return (
    `Write every reply in ${languageName(locale)}, the language ` +
    "selected in this app's settings. Do not switch to the language of the " +
    "user's message, tool output, files or web pages."
  );
}

export function createLanguageProvider(
  options: LanguageContextOptions,
): ContextProvider {
  /** The locale of the last publication; undefined until the first one. */
  let published: string | undefined;

  return {
    name: LANGUAGE_PROVIDER,
    next(): ContextUpdate[] {
      const locale = options.language();
      if (published === locale) return [];
      const replaced = published !== undefined;
      published = locale;
      const name = languageName(locale);
      return [
        {
          title: `Reply language: ${name}`,
          body: `${languageInstruction(locale)}${
            replaced
              ? ` This replaces the earlier language: the user changed the ` +
                `setting, so everything from this point on is answered in ` +
                `${name}.`
              : ""
          }`,
          state: { locale } satisfies LanguageState,
        },
      ];
    },
    rebase(state: unknown): void {
      published = localeOf(state);
    },
  };
}
