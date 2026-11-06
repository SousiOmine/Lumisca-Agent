/**
 * Language names and the output-language rule.
 *
 * The rule lives in a context message, not in the system prompt (see
 * agent/language-context.ts): the language is a setting, so a session that
 * is switched to another language answers in it from the next run without
 * rewriting the prompt — which would cost the provider's cached prefix. What
 * stays here is the vocabulary both sides need, so the setting and the rule
 * cannot name a language differently.
 *
 * The rule is written in ENGLISH for every language, like the rest of the
 * prompt (the guidelines, the tool descriptions, the mode prompts): the
 * model is told which language to answer in, which is the part that must
 * vary, while the machine-facing text stays uniform and reviewable.
 */
import type { Locale } from "../shared/mod.ts";
import type { PromptSection } from "./prompt-sections.ts";

/** English names of the catalogues' languages, as the model knows them. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  ja: "Japanese",
  en: "English",
};

/** The English name of a locale, as the model knows it. Shared by the
 * prompt fragment and the context publication that now carries the rule
 * (see agent/language-context.ts), so the two cannot name a language
 * differently. */
export function languageName(locale: Locale): string {
  return LANGUAGE_NAMES[locale];
}

/** The guideline bullet that fixes the reply language. */
export function outputLanguageBullet(language: Locale): string {
  return `- Write every reply in ${LANGUAGE_NAMES[language]}, the language ` +
    "selected when this session started; do not switch to the language of " +
    "the user's message, tool output, files or web pages.";
}

/** The output-language section of a sub-agent's prompt (the main session's
 * rule travels as a context message): a sub-agent's report is read by its
 * parent and shown to the user, so it must come back in the session's
 * language. */
export function outputLanguageSection(language: Locale): PromptSection {
  return {
    name: "output-language",
    order: -100,
    text: outputLanguageBullet(language),
  };
}

/** The same rule as one sentence, for the single-purpose prompts that are
 * not built from sections (session titles). */
export function outputLanguageSentence(language: Locale): string {
  return `Write the answer in ${LANGUAGE_NAMES[language]}.`;
}
