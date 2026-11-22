/**
 * The server's errors, and the one place an error becomes an HTTP status.
 *
 * Defined outside `routes/` because not only route handlers raise them: the
 * federation client throws `PeerError` for an unreachable peer, and it must
 * not import the HTTP layer to do so (see federation.ts). The route helpers
 * in `routes/util.ts` (`notFound`, `missing`, `jsonError`) build on these and
 * stay there — they are about answering a request.
 */
import { CoreError } from "@lumisca/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Error with an explicit HTTP status. Thrown by route handlers and by the
 * code they call when the status matters (e.g. 404); everything else is
 * classified by errorStatus. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: ContentfulStatusCode,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Error thrown when a peer cannot be reached or answers with an error;
 * carries the HTTP status to return to the UI. */
export class PeerError extends AppError {
  constructor(message: string, status: ContentfulStatusCode) {
    super(message, status);
    this.name = "PeerError";
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
