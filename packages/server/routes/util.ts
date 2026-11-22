import { errorMessage, type WindowQuery } from "@lumisca/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, errorStatus } from "../errors.ts";

/** The errors themselves live in ../errors.ts: the federation client raises
 * `PeerError` and needs the same classification without importing the HTTP
 * layer. The route modules that still import them from here (sessions,
 * stella, prompt uploads) move with their own change; until then this is the
 * single name they share. */
export { AppError, errorStatus };

/** The 404 a route owes when an id names nothing. Kept out of the
 * per-surface resolvers so every route says it the same way. */
export function notFound(what: string, id: string): AppError {
  return new AppError(`${what} not found: ${id}`, 404);
}

/** The 404 for a thing with no id to name (a session that timed out, a
 * prompt that was never saved). */
export function missing(what: string): AppError {
  return new AppError(`${what} not found`, 404);
}

/** The `toolCallId` a body may carry: absent, or a string. Anything else is
 * the caller's mistake, not a stale click. */
export function optionalToolCallId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError("toolCallId must be a string", 400);
  }
  return value;
}

/** Respond with an error message JSON body. */
export function jsonError(
  c: Context,
  error: unknown,
  status?: ContentfulStatusCode,
) {
  return c.json({ error: errorMessage(error) }, status ?? errorStatus(error));
}

/** Parse a JSON request body. Throws 400 on malformed JSON — a syntax
 * error must not masquerade as "field X is required" — and returns
 * undefined only when the body is empty. */
export async function parseBody<T = unknown>(
  c: Context,
): Promise<T | undefined> {
  const text = await c.req.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("Invalid JSON body", 400);
  }
}

/** Require the parsed body itself (most POST/PUT handlers need an object,
 * not an empty body). */
export function requireBody<T>(body: T | undefined, what = "JSON body"): T {
  if (body === undefined || body === null) {
    throw new AppError(`${what} is required`, 400);
  }
  return body;
}

/** Require a string field; throws `"<what> is required"` otherwise.
 * Empty strings pass — use {@link requireNonEmptyString} when emptiness
 * is also invalid. */
export function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a non-empty string field; throws `"<what> is required"` for
 * missing, non-string, or empty values. */
export function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** A string field that may be absent or empty: missing and null both read as
 * "" (the caller decides what an empty value means). A non-string is still
 * rejected — a number or an object at a text field is a client bug, not an
 * omission. */
export function optionalString(value: unknown, what: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new AppError(`${what} must be a string`, 400);
  }
  return value;
}

/** Require a boolean field; throws `"<what> is required"` otherwise. */
export function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a finite-number field; throws `"<what> is required"`
 * otherwise. */
export function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require an array field; throws `"<what> is required"` otherwise. */
export function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError(`${what} is required`, 400);
  }
  return value;
}

/** Require a string array whose entries are all non-empty; throws
 * `"<what> is required"` otherwise. Shared by workspace folders and any
 * future string-list field so the coercion never varies. */
export function requireStringArray(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.length === 0)
  ) {
    throw new AppError(`${what} is required`, 400);
  }
  return value as string[];
}

/**
 * The transcript window one snapshot request asks for, from its query string.
 *
 * `older` is the cursor the previous window returned (an opaque identity — see
 * core's session/transcript-window.ts), absent for the newest window. `limit`
 * is the page size; a value core cannot honour (zero, negative, or not a
 * number) is the core's own invalid error, so the bound lives in one place.
 */
export function parseWindowQuery(url: string): WindowQuery {
  const params = new URL(url).searchParams;
  const older = params.get("older");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new AppError(`limit must be a number: ${rawLimit}`, 400);
  }
  return {
    ...(older === null || older.length === 0 ? {} : { older }),
    ...(limit === undefined ? {} : { limit }),
  };
}
