/**
 * One spec mistake, as the message the model reads.
 *
 * Every check in `validate/` reports through {@link fail}, so a refusal
 * always carries the JSON path that names the mistake. The parser in
 * `build.ts` turns the error into the model's message.
 */

/** A spec mistake, with the place that names it. */
export class AppSpecError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "AppSpecError";
  }
}

export function fail(path: string, message: string): never {
  throw new AppSpecError(path, message);
}

/** The message of a thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
