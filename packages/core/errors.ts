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
