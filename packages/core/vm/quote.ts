/**
 * POSIX shell quoting, for the one place that builds shell commands: the
 * stella VM's file backend (grep/find/sed scripts it sends to `sh -c`) and
 * its command runner (the `env` prefix of a per-call variable).
 *
 * A separate module because both of those need it and neither owns the
 * other: the quoting is the one piece that has to be exactly right, and a
 * second copy is how one of the two ends up subtly wrong.
 */

/**
 * Quote a value for a POSIX shell: single quotes, with an embedded single
 * quote closed, escaped and reopened (`it's` → `'it'\''s'`).
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
