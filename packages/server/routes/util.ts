import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CoreError } from "@lumisca/core";

/** Error with an explicit HTTP status. Thrown by route handlers when the
 * status matters (e.g. 404); everything else is classified by errorStatus. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode,
  ) {
    super(message);
  }
}

/** Classify an unknown error into an HTTP status. Route handlers throw
 * AppError; the core throws typed CoreError (kind maps to a status), so
 * error messages are never matched by text. Anything unclassified is a
 * server fault and maps to 500, never 400 — the client must be able to
 * distinguish "bad input" from "server is broken". */
export function errorStatus(error: unknown): ContentfulStatusCode {
  if (error instanceof AppError) return error.status;
  if (error instanceof CoreError) {
    if (error.kind === "not_found") return 404;
    if (error.kind === "forbidden") return 403;
    if (error.kind === "conflict") return 409;
    if (error.kind === "unavailable") return 503;
    if (error.kind === "invalid") return 400;
  }
  return 500;
}

/** Respond with an error message JSON body. */
export function jsonError(
  c: Context,
  error: unknown,
  status?: ContentfulStatusCode,
) {
  return c.json(
    { error: error instanceof Error ? error.message : String(error) },
    status ?? errorStatus(error),
  );
}

/** Parse a JSON request body; undefined when the body is missing or malformed. */
export async function parseBody<T = unknown>(
  c: Context,
): Promise<T | undefined> {
  const body = await c.req.json().catch(() => undefined);
  return body as T | undefined;
}
