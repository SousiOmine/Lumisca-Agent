import type { MessageKey } from "@lumisca/core/shared";
import type { Locale } from "../../types.ts";

/** Selector labels in each language's own name where it differs: a reader
 * looking for their language finds it without knowing the current one. Read
 * by the overview page and by the first-run setup, which asks the same
 * question (components/setup/WelcomeStep.tsx). */
export const LANGUAGE_OPTION_KEYS: Record<Locale, MessageKey> = {
  ja: "settings.language.option.ja",
  en: "settings.language.option.en",
};
