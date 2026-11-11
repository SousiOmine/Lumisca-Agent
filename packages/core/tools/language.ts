/**
 * Language names and the output-language rule.
 *
 * A session's rule travels as a context message, not in the system prompt
 * (see agent/language-context.ts): the language is a setting, so a session
 * that is switched to another language answers in it from the next run
 * without rewriting the prompt — which would cost the provider's cached
 * prefix. A sub-agent has no context messages of its own, so its prompt
 * carries the rule as one paragraph line instead. What stays here is the
 * vocabulary both sides need, so the setting and the rule cannot name a
 * language differently.
 *
 * The rule is written in ENGLISH for every language, like the rest of the
 * prompt (the tool descriptions, the mode prompts): the model is told which
 * language to answer in, which is the part that must vary, while the
 * machine-facing text stays uniform and reviewable.
 */
import type { Locale } from "../shared/mod.ts";

/** English names of the catalogues' languages, as the model knows them. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  ja: "Japanese",
  en: "English",
};

/** The English name of a locale, as the model knows it. Shared by the
 * prompt fragment and the context publication that carries the rule (see
 * agent/language-context.ts), so the two cannot name a language
 * differently. */
export function languageName(locale: Locale): string {
  return LANGUAGE_NAMES[locale];
}

/** The output-language rule as one line of a prompt: what a sub-agent gets
 * in place of the context message a session receives. */
export function outputLanguageRule(language: Locale): string {
  return (
    `Write every reply in ${LANGUAGE_NAMES[language]}, the language ` +
    "selected when this session started; do not switch to the language of " +
    "the user's message, tool output, files or web pages."
  );
}

/** The same rule as one sentence, for the single-purpose prompts that are
 * not a session (session titles). */
export function outputLanguageSentence(language: Locale): string {
  return `Write the answer in ${LANGUAGE_NAMES[language]}.`;
}
