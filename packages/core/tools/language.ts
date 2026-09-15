/**
 * The output-language rule of the system prompt.
 *
 * A session answers in the language that was selected when it started: the
 * prompt is generated (and snapshotted) at session creation, so the rule is
 * part of that snapshot and never follows later setting changes — a session
 * keeps speaking the language it began in (see core.ts getLanguage).
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

/** The guideline bullet that fixes the reply language. */
export function outputLanguageBullet(language: Locale): string {
  return `- Write every reply in ${LANGUAGE_NAMES[language]}, the language ` +
    "selected when this session started. Keep that language for the whole " +
    "session: do not switch to the language of the user's message, and do " +
    "not mirror the language of tool output, files or web pages.";
}

/** The output-language section of a system prompt (coding, chat and
 * sub-agent prompts alike: a sub-agent's report is read by its parent and
 * shown to the user). */
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
