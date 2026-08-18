/**
 * Errors thrown by the core, classified for the HTTP layer.
 * The server maps `kind` to a status code; message text is never matched.
 */
export class CoreError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "not_found"
      | "forbidden"
      | "conflict"
      | "unavailable"
      | "invalid",
  ) {
    super(message);
    this.name = "CoreError";
  }
}

/** Human-readable message of any thrown value (defined in shared.ts so the
 * CLI and web UI reuse the same helper). */
export { errorMessage } from "./shared.ts";
