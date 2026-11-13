import { type Locale, type MessageKey, translate } from "../shared/i18n/mod.ts";
import type { WebSearchErrorCode } from "./errors.ts";

/** One failure code, phrased for each reader it has. */
interface FailureWording {
  /** What the model is told: what happened and what it can do next.
   * `provider` is the display name ("Exa"). */
  model(provider: string, message: string): string;
  /** Catalogue key of the sentence the settings screen shows. */
  ui: MessageKey;
}

/**
 * One sentence per failure, for the reader it is meant for.
 *
 * The model is told in English (the tool results and the prompts are
 * English); the settings screen is told in the app language, because a
 * rejected key is something the user has to fix. The UI sentence lives in
 * the catalogue with every other user-facing string, so `check:ja` sees it
 * and both languages cannot drift apart. The record is keyed by
 * `WebSearchErrorCode`, so a missing entry fails the type check.
 */
export const WEB_SEARCH_FAILURE_TEXT: Record<
  WebSearchErrorCode,
  FailureWording
> = {
  auth: {
    model: (provider, message) =>
      `The ${provider} API key was rejected. Ask the user to check it in ` +
      `Settings. (${message})`,
    ui: "common.websearch.auth",
  },
  rate_limit: {
    model: (provider, message) =>
      `The ${provider} search provider is rate limited. Try again later. ` +
      `(${message})`,
    ui: "common.websearch.rateLimit",
  },
  quota: {
    model: (provider, message) =>
      `The ${provider} search provider has no remaining quota. (${message})`,
    ui: "common.websearch.quota",
  },
  invalid: {
    model: (provider, message) =>
      `The ${provider} search provider rejected the request: ${message}`,
    ui: "common.websearch.invalid",
  },
  unsupported: {
    model: (provider, message) =>
      `The ${provider} search provider cannot handle this request: ` +
      `${message}`,
    ui: "common.websearch.unsupported",
  },
  unavailable: {
    model: (provider, message) =>
      `Could not reach the ${provider} search provider: ${message}`,
    ui: "common.websearch.unavailable",
  },
};

/** The failure sentence in the app language, for the settings screen. */
export function failureText(
  locale: Locale,
  code: WebSearchErrorCode,
  message: string,
): string {
  return translate(locale, WEB_SEARCH_FAILURE_TEXT[code].ui, { message });
}
