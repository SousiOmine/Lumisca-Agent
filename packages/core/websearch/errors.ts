/**
 * Search failures.
 *
 * Every provider fails differently (401, 429, no balance, unreachable), but
 * the caller only ever needs a handful of kinds. Messages are English on
 * purpose: they end up in front of the model.
 */

export type WebSearchErrorCode =
  /** The API key was not accepted (401 / 403). */
  | "auth"
  /** Rate limited (429). */
  | "rate_limit"
  /** Out of balance or quota (402 and friends). */
  | "quota"
  /** Unreachable, timed out, 5xx. */
  | "unavailable"
  /** The request was refused (400 / 404 and friends). */
  | "invalid"
  /** This provider cannot handle the request (a PDF fetched directly, ...). */
  | "unsupported";

export class WebSearchError extends Error {
  /** HTTP status when there was one. */
  readonly status: number | null;

  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WebSearchError";
    this.status = options.status ?? null;
  }

  /** A misspelled provider id, an unknown URL scheme: input the user can
   * fix, not a provider that is down. */
  get isUserInputProblem(): boolean {
    return this.code === "auth" || this.code === "invalid";
  }
}
