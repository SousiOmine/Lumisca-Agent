import type { WebSearchErrorCode } from "./errors.ts";
import type { Locale } from "../shared/i18n/mod.ts";

/** One failure code, phrased for each reader it has. */
interface FailureWording {
  /** What the model is told: what happened and what it can do next.
   * `provider` is the display name ("Exa"). */
  model(provider: string, message: string): string;
  /** What the settings screen shows, per app language. */
  ui: Record<Locale, (message: string) => string>;
}

/**
 * One sentence per failure, for the reader it is meant for.
 *
 * The model is told in English (the tool results and the prompts are
 * English); the settings screen is told in the app language, because a
 * rejected key is something the user has to fix. Both live in one table so
 * adding a kind cannot update only one of them: the record is keyed by
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
    ui: {
      ja: (message) => `API キーが受け付けられませんでした（${message}）`,
      en: (message) => `The API key was rejected (${message})`,
    },
  },
  rate_limit: {
    model: (provider, message) =>
      `The ${provider} search provider is rate limited. Try again later. ` +
      `(${message})`,
    ui: {
      ja: (message) => `レート制限に達しました（${message}）`,
      en: (message) => `Rate limited (${message})`,
    },
  },
  quota: {
    model: (provider, message) =>
      `The ${provider} search provider has no remaining quota. (${message})`,
    ui: {
      ja: (message) => `利用枠が不足しています（${message}）`,
      en: (message) => `No remaining quota (${message})`,
    },
  },
  invalid: {
    model: (provider, message) =>
      `The ${provider} search provider rejected the request: ${message}`,
    ui: {
      ja: (message) => `リクエストが受け付けられませんでした（${message}）`,
      en: (message) => `The request was rejected (${message})`,
    },
  },
  unsupported: {
    model: (provider, message) =>
      `The ${provider} search provider cannot handle this request: ` +
      `${message}`,
    ui: {
      ja: (message) => `このプロバイダでは扱えません（${message}）`,
      en: (message) => `This provider cannot handle the request (${message})`,
    },
  },
  unavailable: {
    model: (provider, message) =>
      `Could not reach the ${provider} search provider: ${message}`,
    ui: {
      ja: (message) => `接続できませんでした（${message}）`,
      en: (message) => `Could not connect (${message})`,
    },
  },
};

/** The failure sentence in the app language, for the settings screen. */
export function failureText(
  locale: Locale,
  code: WebSearchErrorCode,
  message: string,
): string {
  return WEB_SEARCH_FAILURE_TEXT[code].ui[locale](message);
}
