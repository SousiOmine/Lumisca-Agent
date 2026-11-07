/** Shared transport pieces of the ChatGPT provider: the HTTP client seam
 * and the bounds one request gets. */

/** HTTP client the ChatGPT flows use; injectable so tests never touch the
 * network. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Upper bound on a single token, catalog or refresh request. Long enough
 * for a slow link, short enough that a stalled request cannot hold a run. */
export const CHATGPT_REQUEST_TIMEOUT_MS = 30_000;

/** Response bodies can carry a long JSON error; keep the message usable. */
export function truncateBody(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

/** The caller's abort signal plus a per-request bound. Without it a stalled
 * request would hold a run (or a login flow) until something else gives up. */
export function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CHATGPT_REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
