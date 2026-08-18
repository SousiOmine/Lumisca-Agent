/** Shared `--flag value` / `--switch` argument parsing for the CLI
 * commands (the main command and `run`). Previously two near-identical
 * parsers lived in mod.ts and run.ts; this is the single one.
 * Help and error reporting are injected so each command keeps its own
 * behavior (mod.ts prints and exits, run.ts throws). */

/** A parse error with a Japanese message; each command maps it to its own
 * reporting. */
export class CliParseError extends Error {}

/** One flag definition. */
export interface FlagDef {
  /** Canonical name without the leading "--". */
  name: string;
  /** The flag takes a value: `--name <value>`. Omitted = a boolean switch. */
  hasValue?: boolean;
  /** A `-x` alias (e.g. "-h"). */
  alias?: string;
}

/** Parsed flags: `values` holds value-taking flags by name, `switches` the
 * booleans that were present. */
export interface ParsedFlags {
  values: Record<string, string>;
  switches: Set<string>;
}

/** Parse flat `--flag value` / `--switch` argv (no positional arguments).
 * A following known flag counts as a missing value, but other
 * "--"-prefixed text is accepted as a value (e.g. `--prompt "--foo"`).
 * A bare "--" separator is skipped (inserted by `deno task cli -- …`).
 * `--help`/`-h` invokes `onHelp` (which never returns); unknown flags and
 * missing values invoke `onError`. */
export function parseFlags(
  args: string[],
  defs: FlagDef[],
  onHelp: () => never,
  onError: (message: string) => never = (message) => {
    throw new CliParseError(message);
  },
): ParsedFlags {
  const byToken = new Map<string, FlagDef>();
  for (const def of defs) {
    byToken.set(`--${def.name}`, def);
    if (def.alias !== undefined) byToken.set(def.alias, def);
  }
  const known = (token: string): boolean =>
    byToken.has(token) || token === "--help" || token === "-h";

  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") continue;
    if (token === "--help" || token === "-h") onHelp();
    const def = byToken.get(token);
    if (def === undefined) onError(`不明な引数: ${token}`);
    if (def.hasValue === true) {
      const value = args[i + 1];
      if (value === undefined || known(value)) {
        onError(`--${def.name} には値が必要です`);
      }
      values[def.name] = value;
      i++;
    } else {
      switches.add(def.name);
    }
  }
  return { values, switches };
}
