/**
 * A provider's own words for a rejected request: the context-window
 * overflows, and the counts it reports beside them.
 *
 * Two layers read the same failure. The retry policy (ai/retry-policy.ts)
 * decides whether a failed turn is worth a condensed restart; the transport
 * (ai/output-cap-recovery.ts) reads the counts to shrink the completion cap
 * and re-send the request unchanged. Both must agree on what an overflow is,
 * so the wording is defined here and only here.
 */

/** Error-message signatures of a provider-confirmed context overflow: the
 * request was rejected because prompt + completion exceeded the model's
 * window. The wording differs per provider (and per gateway — OpenCode Go
 * forwards Console Go's "This model's maximum context length is ... Please
 * reduce the length of the messages or completion"), so the pattern covers
 * the families rather than one literal string. */
const CONTEXT_OVERFLOW_PATTERN =
  /maximum context length|context length is|context_length_exceeded|context window|reduce the length of the messages|prompt is too long|too many tokens|input token count|exceeds the maximum/i;

/** True when the text reports a request rejected for exceeding the model's
 * context window. Shared by every classifier, so a failure one layer treats
 * as an overflow is an overflow for the other as well. */
export function isContextOverflowText(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(text);
}

/** The counts a provider reports beside an overflow. Each side is optional:
 * a provider that names only the window (or only the prompt) still lets the
 * caller act on what it knows. */
export interface ContextOverflowNumbers {
  /** The window the provider enforces (prompt + completion). */
  windowTokens?: number;
  /** Prompt tokens the provider counted for the rejected request. */
  promptTokens?: number;
}

/** Wordings that carry the window. OpenAI, OpenCode Go and Console Go share
 * one ("maximum context length is N tokens"); Google names it after
 * "maximum number of tokens allowed (N)"; Anthropic writes
 * "prompt is too long: N tokens > M maximum". */
const WINDOW_PATTERNS: readonly RegExp[] = [
  /maximum context length is (\d+)/i,
  /maximum number of tokens allowed \((\d+)\)/i,
  />\s*(\d+)\s*maximum/i,
];

/** Wordings that carry the prompt count. The same three families again, plus
 * OpenAI's older "N in your prompt" form. */
const PROMPT_PATTERNS: readonly RegExp[] = [
  /(\d+)\s+in the messages/i,
  /(\d+)\s+in your prompt/i,
  /prompt is too long:\s*(\d+)/i,
  /input token count \((\d+)\)/i,
];

/** The first positive integer the patterns find in `text`, or undefined. */
function firstNumber(
  patterns: readonly RegExp[],
  text: string,
): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

/**
 * Read the token counts from an overflow message. A provider that words its
 * rejection differently (or omits the numbers) yields an empty result — the
 * caller must then decide without them rather than guess a size.
 *
 * The reported failure reads, for example: "This model's maximum context
 * length is 1048576 tokens. However, you requested 1050931 tokens (666931
 * in the messages, 384000 in the completion)." → window 1,048,576, prompt
 * 666,931.
 */
export function parseContextOverflow(text: string): ContextOverflowNumbers {
  if (!isContextOverflowText(text)) return {};
  const windowTokens = firstNumber(WINDOW_PATTERNS, text);
  const promptTokens = firstNumber(PROMPT_PATTERNS, text);
  return {
    ...(windowTokens !== undefined ? { windowTokens } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
  };
}
