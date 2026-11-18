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

/** Human-readable message of any thrown value (defined in shared/mod.ts so the
 * server and web UI reuse the same helper). */
export { errorMessage } from "./shared/mod.ts";

/** The `code` Node and Bun put on filesystem and network errors. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** A missing path (ENOENT), from `node:fs` or Bun. */
export function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** A path that already exists (EEXIST), from `node:fs` or Bun. */
export function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

/** A port another process holds (EADDRINUSE). */
export function isAddrInUseError(error: unknown): boolean {
  return (
    errorCode(error) === "EADDRINUSE" ||
    (error instanceof Error && error.name === "AddrInUse")
  );
}
