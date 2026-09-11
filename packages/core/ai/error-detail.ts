/**
 * Failure description of one LLM call.
 *
 * The Vercel transport throws `APICallError`s whose `message` is often a
 * generic wrapper ("Failed to process successful response" — provider-utils
 * uses it when reading a 2xx body fails mid-stream) while the actionable
 * reason hides in `cause`, `statusCode`, `url` or `responseBody`. Rendering
 * only the message made those failures undiagnosable: nothing in the UI,
 * the transcript, or the server log said what actually went wrong. This
 * module renders the detail beside the message, and keeps the provider's
 * own retryability flag so the retry policy does not have to guess from
 * wording.
 */

/** What the transport reports about a failed call. */
export interface FailedCall {
  /** The provider's message (what the user sees first). */
  message: string;
  /** Non-message detail: HTTP status, URL, response body, cause chain. */
  detail?: string;
  /** The provider marked the failure retryable (`APICallError.isRetryable`). */
  retryable?: boolean;
}

/** Bounds of the rendered detail, so one failure cannot flood a banner. */
const MAX_DETAIL_CHARS = 240;
const MAX_BODY_CHARS = 200;
const MAX_CAUSE_DEPTH = 3;

export function describeFailedCall(error: unknown): FailedCall {
  if (typeof error === "string") return { message: error };
  if (!(error instanceof Error)) return { message: String(error) };

  const parts: string[] = [];
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && Number.isFinite(status)) {
    parts.push(`status ${status}`);
  }
  const url = (error as { url?: unknown }).url;
  if (typeof url === "string" && url.length > 0) parts.push(`url ${url}`);
  const body = (error as { responseBody?: unknown }).responseBody;
  if (typeof body === "string" && body.trim().length > 0) {
    parts.push(`body ${clip(body.trim(), MAX_BODY_CHARS)}`);
  }
  const cause = causeChain((error as { cause?: unknown }).cause);
  if (cause !== undefined) parts.push(`cause ${cause}`);

  const detail = clip(parts.join("; "), MAX_DETAIL_CHARS).trim();
  return {
    message: error.message.length > 0 ? error.message : error.name,
    ...(detail.length > 0 ? { detail } : {}),
    ...((error as { isRetryable?: unknown }).isRetryable === true
      ? { retryable: true }
      : {}),
  };
}

/** The message a transcript/UI row carries: the provider's text plus the
 * detail, so a post-mortem needs no debug logging. */
export function failureText(failed: FailedCall): string {
  return failed.detail === undefined
    ? failed.message
    : `${failed.message} (${failed.detail})`;
}

/** Render a `cause` chain (bounded depth) as `Name: message [code]`. */
function causeChain(cause: unknown, depth = 0): string | undefined {
  if (cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH) {
    return undefined;
  }
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  const codeText = typeof code === "string" ? ` [${code}]` : "";
  const next = causeChain((cause as { cause?: unknown }).cause, depth + 1);
  const head = `${cause.name}: ${cause.message}${codeText}`;
  return next === undefined ? head : `${head} → ${next}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
