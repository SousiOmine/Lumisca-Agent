/**
 * JSON requests to the providers.
 *
 * The parts that never change between providers live here: combining the
 * caller's abort with a timeout, turning an HTTP status into a failure kind,
 * and pulling a readable sentence out of an error body. A provider supplies
 * its URL, headers, body and how to read the answer — nothing else.
 */

import { errorMessage } from "../shared/misc.ts";
import { WebSearchError } from "./errors.ts";
import { MAX_ERROR_DETAIL_CHARS } from "./constants.ts";
import type { FetchLike } from "./types.ts";

export interface JsonRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** The display name used in failure messages ("Exa"). */
  provider: string;
}

/** POST (or GET) JSON and read JSON back. Every failure is a
 * {@link WebSearchError}. */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<unknown> {
  const response = await send(fetchImpl, url, init, options);
  if (!response.ok) {
    throw responseError(
      options.provider,
      response.status,
      await readErrorDetail(response),
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new WebSearchError(
      "unavailable",
      `${options.provider} returned a response that is not JSON`,
      { status: response.status, cause: error },
    );
  }
}

/** One request with the timeout and the caller's abort combined. A failure
 * to reach the provider at all becomes `unavailable`. */
async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout]);

  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (timeout.aborted) {
      throw new WebSearchError(
        "unavailable",
        `${options.provider} did not respond in time`,
        { cause: error },
      );
    }
    if (options.signal?.aborted === true) {
      throw new WebSearchError(
        "unavailable",
        `${options.provider} request was aborted`,
        { cause: error },
      );
    }
    throw new WebSearchError(
      "unavailable",
      `${options.provider} could not be reached: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/** An HTTP status as a failure kind. */
function responseError(
  provider: string,
  status: number,
  detail: string,
): WebSearchError {
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  const message = `${provider} returned HTTP ${status}${suffix}`;

  if (status === 401 || status === 403) {
    return new WebSearchError("auth", message, { status });
  }
  if (status === 429) {
    return new WebSearchError("rate_limit", message, { status });
  }
  if (status === 402) return new WebSearchError("quota", message, { status });
  if (status >= 400 && status < 500) {
    return new WebSearchError("invalid", message, { status });
  }
  return new WebSearchError("unavailable", message, { status });
}

/** A readable sentence from a failure body, or "" when there is none. */
async function readErrorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return clip(oneLine(trimmed), MAX_ERROR_DETAIL_CHARS);
  }

  const message = findMessage(parsed) ?? oneLine(trimmed);
  return clip(message, MAX_ERROR_DETAIL_CHARS);
}

/** The first human-readable string inside a JSON error body. Providers wrap
 * it differently (`error`, `error.message`, `detail`, `message`), so all the
 * spellings are searched instead of guessing one. */
function findMessage(value: unknown): string | null {
  if (typeof value === "string") return value.length === 0 ? null : value;

  if (Array.isArray(value)) {
    const messages = value
      .map(findMessage)
      .filter((message): message is string => message !== null);
    return messages.length === 0 ? null : messages.join("; ");
  }

  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["error", "detail", "message", "msg"] as const) {
    const message = findMessage(record[key]);
    if (message !== null) return message;
  }
  return null;
}

/** One line, with runs of whitespace collapsed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` characters, with an ellipsis marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
