/**
 * Shared argument handling for tool definitions: the `cwd` wording every
 * shell tool shows, and the `prepareArguments` shim that fills a session's
 * single working folder in when the model omits it.
 *
 * The wording lives here because two tools ask the same question (`bash`
 * and `async_bash`); a model comparing them must not find two descriptions
 * of one argument.
 */

/** The `cwd` parameter's description, identical for every shell tool. */
export const WORKDIR_DESCRIPTION =
  "Working directory (required): a workspace folder name (e.g. `Aaa`) or " +
  "an absolute path. Pass it on every call, even when the command starts " +
  "with `cd` — this argument decides where the shell starts and the " +
  "call fails without it.";

/** Tool-call arguments as a plain record. Anything else (null, an array, a
 * scalar) becomes an empty object, so a malformed call fails schema
 * validation with a readable error instead of throwing inside `execute`. */
export function asArgsRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/** `prepareArguments` for a tool whose `cwd` may be omitted: the session's
 * one working folder is injected before validation. Undefined when the
 * caller has no default, so the tool keeps its required-argument contract. */
export function defaultCwdArguments(
  cwd: string | undefined,
): ((args: unknown) => Record<string, unknown>) | undefined {
  if (cwd === undefined) return undefined;
  return (args) => {
    const record = asArgsRecord(args);
    return record.cwd === undefined ? { ...record, cwd } : record;
  };
}
