/**
 * The machine's environment variables: the values the user typed into a
 * dialog when the agent asked for one.
 *
 * The values never travel back to the model. The agent names a variable, the
 * user enters the value in the browser, and the server writes it into the
 * machine; from then on every command the agent runs has it, and nothing the
 * agent reads says what it is. That is why the store is the only thing that
 * touches a value: the tool that asked has no argument and no result that
 * could carry it.
 *
 * Two files, for one reason: `env.json` is a shape that can be merged (so
 * asking again for a name replaces that entry and leaves the others alone),
 * and `env.sh` is what a login shell can source. The shell file cannot be
 * merged: a value may contain quotes, newlines or `#`, and reading a shell
 * file back is a parser this module would have to own.
 *
 * Both are written with `umask 077` (0600). They are still readable by the
 * agent's own commands — the machine is a single account with passwordless
 * sudo, so nothing inside it can be hidden from it. The contract is narrower
 * and exact: the VALUE is never in a tool's arguments or result, nor in the
 * conversation.
 */
import { CoreError } from "../errors.ts";
import type { VmExec } from "./container.ts";
import { VM_ENV_DIR, VM_ENV_JSON, VM_ENV_SH } from "./contract.ts";
import { shellQuote } from "./quote.ts";

/** A name is an identifier a shell can export: an empty or punctuated name
 * would either not be usable or would change what the sourced file means. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longest name accepted. Bindings beyond this are not something a program
 * asks for; the bound keeps the dialog's line readable. */
export const MAX_ENV_NAME_CHARS = 64;

/** Longest value accepted (a certificate or a long token fits; a file does
 * not — a big blob belongs in a file the agent can read). */
export const MAX_ENV_VALUE_CHARS = 16 * 1024;

/** A read or a write of the pair crosses into the machine, so it gets a
 * bound of its own: `cat` on a small local file answers at once. */
const FILE_TIMEOUT_MS = 30_000;

/** Kept wall of one file: the JSON of a few keys, or the script built from
 * it. A machine with hundreds of entries is not a case this serves. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** The shell prefix that puts the saved variables into a command.
 *
 * Prefixed rather than exported by `podman exec --env`: the values would
 * then be an argv on the host, where any process can read them. An absent
 * file is not an error — a machine where the user never entered a value must
 * run every command exactly as before. */
export const VM_ENV_SOURCE = `[ -f ${VM_ENV_SH} ] && . ${VM_ENV_SH}; `;

/** Parse `name` as the tool's argument or a route's field, or say why not.
 *
 * Called before the user is asked, so a typo is answered by a tool error
 * rather than by a dialog the user has to cancel. */
export function requireEnvName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new CoreError("name must not be empty", "invalid");
  }
  if (name.length > MAX_ENV_NAME_CHARS) {
    throw new CoreError(
      `name must be at most ${MAX_ENV_NAME_CHARS} characters (got ` +
        `${name.length})`,
      "invalid",
    );
  }
  if (!ENV_NAME_RE.test(name)) {
    throw new CoreError(
      `name must be a shell identifier (letters, digits and _, not starting ` +
        `with a digit): got "${name}"`,
      "invalid",
    );
  }
  return name;
}

/** Parse the value the user typed, or say why it cannot be stored.
 *
 * Whitespace around a pasted value is dropped (a token copied with its line
 * ending would never match); everything else is kept as typed, because only
 * the program that reads it knows what a meaningful character is. */
export function requireEnvValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new CoreError("value is required", "invalid");
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new CoreError("value must not be empty", "invalid");
  }
  if (value.length > MAX_ENV_VALUE_CHARS) {
    throw new CoreError(
      `value must be at most ${MAX_ENV_VALUE_CHARS} characters (got ` +
        `${value.length})`,
      "invalid",
    );
  }
  if (value.includes("\0")) {
    throw new CoreError("value must not contain a NUL character", "invalid");
  }
  return value;
}

/** The stored entries as an object, tolerating a missing or broken file: an
 * unreadable store must not make every command fail, and a machine that has
 * never been asked for a value has no file at all. */
export function parseEnvJson(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return entries;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return entries;
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !ENV_NAME_RE.test(name)) continue;
    entries[name] = value;
  }
  return entries;
}

/** The shell script a command sources: one `export` per entry, sorted so the
 * file reads the same way whenever it is rewritten. */
export function envScript(entries: Record<string, string>): string {
  const lines = Object.keys(entries).sort().map((name) =>
    `export ${name}=${shellQuote(entries[name]!)}`
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The pair of files, read and written through the machine's exec seam.
 *
 * Writes are serialized: a read-modify-write that interleaves with another
 * one loses the entry it read, and two conversations on one machine (two
 * dialogs answered at once) is an ordinary thing to do.
 */
export class VmEnvStore {
  readonly #exec: VmExec;
  /** The tail of the write queue; always settles, so one failed write does
   * not cancel the next. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(exec: VmExec) {
    this.#exec = exec;
  }

  /** The names set in the machine, sorted. Never the values: this is what
   * the dialog and the tool report. */
  async names(): Promise<string[]> {
    return Object.keys(await this.read()).sort();
  }

  /** Whether `name` already has a value (the dialog says so before the user
   * overwrites it). */
  async has(name: string): Promise<boolean> {
    return Object.hasOwn(await this.read(), name);
  }

  /** Store `value` under `name`, replacing what was there and keeping every
   * other entry. Rejects when the machine could not be written — the caller
   * must not tell the user (or the agent) that it worked. */
  set(name: string, value: string): Promise<void> {
    return this.#serial(async () => {
      const entries = await this.read();
      entries[name] = value;
      await this.#write(VM_ENV_JSON, `${JSON.stringify(entries, null, 2)}\n`);
      await this.#write(VM_ENV_SH, envScript(entries));
    });
  }

  /** The stored entries. */
  async read(): Promise<Record<string, string>> {
    const result = await this.#exec(
      ["sh", "-c", 'cat "$1" 2>/dev/null || true', "sh", VM_ENV_JSON],
      { timeoutMs: FILE_TIMEOUT_MS, maxOutput: MAX_READ_BYTES },
    );
    if (result.exitCode !== 0) return {};
    return parseEnvJson(result.stdout);
  }

  /** One file, through stdin: the content (a value) must never be an argv on
   * the host, where `ps` would show it. */
  async #write(path: string, text: string): Promise<void> {
    const result = await this.#exec(
      [
        "sh",
        "-c",
        'umask 077; mkdir -p "$1" || exit 1; cat > "$2" && chmod 600 "$2"',
        "sh",
        VM_ENV_DIR,
        path,
      ],
      {
        timeoutMs: FILE_TIMEOUT_MS,
        maxOutput: 4096,
        stdin: new TextEncoder().encode(text),
      },
    );
    if (result.exitCode !== 0) {
      throw new CoreError(
        `Could not save the environment variable: ${
          result.stderr.trim() || `exit code ${result.exitCode}`
        }`,
        "unavailable",
      );
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }
}
