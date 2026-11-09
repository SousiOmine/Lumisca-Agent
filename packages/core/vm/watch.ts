/**
 * The check a `watch` routine runs between its runs.
 *
 * A watch routine is a stored request plus a question the SERVER answers:
 * "has this changed?" The answer costs nothing but a request, a stat or a
 * command — no inference call — and a run starts only when the answer is
 * yes. That is the whole economy of the trigger: a routine that checks every
 * five minutes would otherwise pay for a model call every five minutes to be
 * told nothing happened.
 *
 * Two rules shape the code below.
 *
 * - **The check is not the work.** It reads one URL, one file's metadata or
 *   one command's exit status and a slice of its output. Reading and judging
 *   the content is what the RUN does once the check fires; a check that tried
 *   to be clever would be an inference call with extra steps.
 * - **The first check only records a baseline.** Nothing has been compared
 *   yet, so nothing can differ. Reporting the first observation as a change
 *   would fire a run the instant a routine was saved, and again whenever the
 *   stored state was lost — a routine whose "changes" are its own bookkeeping
 *   is worse than none.
 *
 * Everything runs INSIDE the machine: the file and the command are the
 * agent's own (a path relative to its working folder, a command it could have
 * typed), and an HTTP check goes out from the machine, so the address is the
 * one that machine can reach. A check that ran on the host would see a
 * different filesystem and a different network, and would report a change the
 * agent cannot act on.
 */
import { createHash } from "node:crypto";
import type { WatchSource } from "../shared/routine.ts";
import type { CommandRunner } from "../tools/command-backend.ts";
import type { FileBackend } from "../tools/file-backend.ts";

/** What one check observed. The shape is deliberately small and plain: it is
 * stored as JSON on the routine's row and compared on the next check. */
export type WatchState =
  | { kind: "http"; status: number; hash: string | null; hasIncludes: boolean }
  | { kind: "file"; mtimeMs: number | null; hash: string | null }
  | { kind: "command"; exitCode: number; hasIncludes: boolean };

/** Why a check could not answer, or null when it did. A check that cannot
 * answer is NOT a change: a machine that is down, a URL that times out and a
 * file that does not exist yet are all "nothing to compare", and firing the
 * routine for them would make every transient failure a run. */
export interface WatchOutcome {
  state: WatchState | null;
  changed: boolean;
  /** What to tell the routine's row when the check could not answer. */
  problem?: string;
}

/** The body cap of an HTTP check. A page can be megabytes; only a digest and
 * a substring test are taken from it, so the machine-side fetch reads at most
 * this much of the body (see machineWatchFetch). */
const HTTP_MAX_BYTES = 5_000_000;

/** A request may spend this long on one address. Shorter than the runner's
 * own limit, so a stalled address reports "timed out" as a check problem
 * instead of being killed as a command that never answered. */
const HTTP_TIMEOUT_SEC = 30;

/** The largest body curl is allowed to write. Above it the check reports a
 * problem rather than hashing a prefix: a digest of the first few megabytes
 * would call a page unchanged while its tail changed, which is worse than
 * saying nothing was observed. */
const HTTP_MAX_FETCH_BYTES = HTTP_MAX_BYTES * 2;

/** What one check needs from the machine. `fetch` is a seam so a test can
 * answer without a network, and so the caller decides where the request goes
 * out from (see the module comment). */
export interface WatchDeps {
  /** The machine's command runner: the file check's stat and the command
   * check both run there, because the file and the command are the agent's
   * own (see the module comment). */
  runner: CommandRunner;
  /** Working folder the check runs in (the agent's own). */
  workdir: string;
  /** Fetch a URL. Defaults to the global `fetch`, which is the HOST's
   * network; a caller that has a machine passes `machineWatchFetch` so the
   * request goes out from there (see the module comment). */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** What the machine-side fetch needs: the same runner the other checks use,
 * plus the file backend the body is read back through. */
export interface MachineWatchDeps {
  runner: CommandRunner;
  files: FileBackend;
  /** Working folder curl runs in (the agent's own). */
  workdir: string;
  signal?: AbortSignal;
}

/** A `fetch` that makes its request INSIDE the machine (see the module
 * comment): curl writes the body to a file under the agent's own root, which
 * is read back through the file backend and removed.
 *
 * A file rather than stdout because the body must be hashed here and the
 * runner's stdout is capped for a terminal: a page of a few megabytes would
 * arrive cut, and the cut would look like a change. The file lives in the
 * tool-output directory (the same one the spiller uses) so nothing new
 * appears in the agent's view, and it is removed even when curl fails.
 *
 * The status comes from curl's `-w` on stdout, so an HTTP error is still an
 * observation (a watch on "the status is 200" must fire on a 500), while a
 * transport failure throws — `runWatch` turns that into a problem, not a
 * change.
 *
 * The directory is created here, in the same shell, rather than assumed:
 * `files.writeText` makes its parent folder, but curl writes the body
 * itself, and the tool-output directory exists only after some tool has
 * spilled something. On a machine that has not, every HTTP check failed with
 * curl's exit 23 ("Failure writing output to destination") and the watch
 * never fired. `umask 077` matches the spiller: a fetched page can be an
 * internal one, and it is removed a moment later. */
export function machineWatchFetch(deps: MachineWatchDeps): typeof fetch {
  const impl = async (input: unknown): Promise<Response> => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
      ? input.href
      : String(input);
    const root = (deps.files.roots[0] ?? "/").replace(/[\\/]+$/, "");
    const bodyDir = `${root}/.lumisca-tool-output`;
    const bodyPath = `${bodyDir}/watch-${crypto.randomUUID()}.body`;
    try {
      const result = await deps.runner.run(
        `mkdir -p ${shellQuote(bodyDir)} && umask 077 && ` +
          `curl -sS -L --compressed --max-time ${HTTP_TIMEOUT_SEC} ` +
          `--max-redirs 5 --max-filesize ${HTTP_MAX_FETCH_BYTES} ` +
          `-o ${shellQuote(bodyPath)} -w '%{http_code}' -- ${shellQuote(url)}`,
        {
          cwd: deps.workdir,
          timeoutSec: HTTP_TIMEOUT_SEC + 15,
          maxOutputChars: 64,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          firstLine(result.stderr) ||
            `the request failed (curl exit ${result.exitCode})`,
        );
      }
      const status = Number(result.stdout.trim());
      if (!Number.isInteger(status) || status <= 0) {
        throw new Error("the response had no status");
      }
      const { bytes } = await deps.files.readHead(bodyPath, HTTP_MAX_BYTES);
      // A body that is absent by definition (curl writes nothing for these)
      // must not be handed to Response: it refuses a body on them.
      const nullBody = status === 204 || status === 205 || status === 304;
      return new Response(
        nullBody ? null : new TextDecoder().decode(bytes),
        { status },
      );
    } finally {
      await deps.files.removeFile(bodyPath).catch(() => {});
    }
  };
  return impl as unknown as typeof fetch;
}

/** Run one check and compare it with the stored state.
 *
 * `previous` is the state the last check left (undefined on the first check
 * after the routine was saved, or after the stored state was lost). */
export async function runWatch(
  source: WatchSource,
  previous: WatchState | undefined,
  deps: WatchDeps,
): Promise<WatchOutcome> {
  const current = await observe(source, deps);
  if (current.state === null) {
    return {
      state: null,
      changed: false,
      ...(current.problem === undefined ? {} : { problem: current.problem }),
    };
  }
  if (previous === undefined || previous.kind !== current.state.kind) {
    // The first look, or a source that changed shape: record, do not fire.
    return { state: current.state, changed: false };
  }
  return {
    state: current.state,
    changed: differs(source, previous, current.state),
  };
}

/** Whether two observations of one source disagree about what the watch
 * asks. Only the fields the source names are compared: a watch on
 * `{"status":200}` must not fire because the page's words changed. */
function differs(
  source: WatchSource,
  previous: WatchState,
  current: WatchState,
): boolean {
  if (previous.kind === "http" && current.kind === "http") {
    const expect = source.kind === "http" ? source.expect : {};
    if (expect.status !== undefined && previous.status !== current.status) {
      return true;
    }
    if (expect.hash === true && previous.hash !== current.hash) return true;
    if (
      expect.includes !== undefined &&
      previous.hasIncludes !== current.hasIncludes
    ) {
      return true;
    }
    return false;
  }
  if (previous.kind === "file" && current.kind === "file") {
    const compare = source.kind === "file" ? source.compare : "mtime";
    return compare === "hash"
      ? previous.hash !== current.hash
      : previous.mtimeMs !== current.mtimeMs;
  }
  if (previous.kind === "command" && current.kind === "command") {
    const expect = source.kind === "command" ? source.expect : {};
    if (
      expect.exitCode !== undefined && previous.exitCode !== current.exitCode
    ) {
      return true;
    }
    if (
      expect.includes !== undefined &&
      previous.hasIncludes !== current.hasIncludes
    ) {
      return true;
    }
    return false;
  }
  return false;
}

/** Take one observation. `state: null` means the check could not answer. */
async function observe(
  source: WatchSource,
  deps: WatchDeps,
): Promise<{ state: WatchState | null; problem?: string }> {
  switch (source.kind) {
    case "http":
      return await observeHttp(source, deps);
    case "file":
      return await observeFile(source, deps);
    case "command":
      return await observeCommand(source, deps);
  }
}

async function observeHttp(
  source: Extract<WatchSource, { kind: "http" }>,
  deps: WatchDeps,
): Promise<{ state: WatchState | null; problem?: string }> {
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(source.url, {
      method: "GET",
      redirect: "follow",
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (error) {
    return {
      state: null,
      problem: `the address could not be reached (${messageOf(error)})`,
    };
  }
  // A failed request is an observation, not a failure to observe: a watch on
  // "the status is 200" must fire when the server starts answering 500.
  const status = response.status;
  let hash: string | null = null;
  let hasIncludes = false;
  if (source.expect.hash === true || source.expect.includes !== undefined) {
    try {
      const body = await response.text();
      const bytes = new TextEncoder().encode(body.slice(0, HTTP_MAX_BYTES));
      if (source.expect.hash === true) {
        hash = createHash("sha256").update(bytes).digest("hex");
      }
      if (source.expect.includes !== undefined) {
        hasIncludes = body.includes(source.expect.includes);
      }
    } catch (error) {
      return {
        state: null,
        problem: `the body could not be read (${messageOf(error)})`,
      };
    }
  }
  return { state: { kind: "http", status, hash, hasIncludes } };
}

async function observeFile(
  source: Extract<WatchSource, { kind: "file" }>,
  deps: WatchDeps,
): Promise<{ state: WatchState | null; problem?: string }> {
  // The file is the machine's, so both the stat and the digest are taken
  // there: the host cannot see it.
  const quoted = shellQuote(source.path);
  const command = source.compare === "hash"
    ? `stat -c %Y -- ${quoted} && sha256sum -- ${quoted} | cut -d" " -f1`
    : `stat -c %Y -- ${quoted}`;
  const result = await deps.runner.run(command, {
    cwd: deps.workdir,
    timeoutSec: 30,
    maxOutputChars: 4_000,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (result.exitCode !== 0) {
    return {
      state: null,
      problem: `the file could not be read at ${source.path} (${
        firstLine(result.stderr)
      })`,
    };
  }
  const lines = result.stdout.trim().split("\n").filter((line) =>
    line.length > 0
  );
  const seconds = Number(lines[0]);
  if (!Number.isFinite(seconds)) {
    return {
      state: null,
      problem: `the file's timestamp could not be read at ${source.path}`,
    };
  }
  return {
    state: {
      kind: "file",
      mtimeMs: seconds * 1_000,
      hash: source.compare === "hash" ? lines[1]?.trim() ?? null : null,
    },
  };
}

async function observeCommand(
  source: Extract<WatchSource, { kind: "command" }>,
  deps: WatchDeps,
): Promise<{ state: WatchState | null; problem?: string }> {
  const result = await deps.runner.run(source.command, {
    cwd: deps.workdir,
    timeoutSec: 60,
    maxOutputChars: 64_000,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  // A non-zero status is the observation, not a failure: "the check fails
  // when the build is broken" is a watch on an exit code.
  // No exit code means the command was killed (a timeout), which is an
  // observation the watch cannot compare: -1 is not a status the shell
  // produces, so it reads as "failed to observe" rather than as a change.
  if (result.exitCode === undefined) {
    return {
      state: null,
      problem: "the command did not finish within its time limit",
    };
  }
  const hasIncludes = source.expect.includes === undefined
    ? false
    : result.stdout.includes(source.expect.includes);
  return {
    state: { kind: "command", exitCode: result.exitCode, hasIncludes },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** One shell word, quoted so a path with a space (or a quote) survives. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The stored state, decoded. A row written by another build (or edited by
 * hand) reads as "no previous state", which makes the next check a baseline:
 * an unreadable comparison must not fire a run. */
export function parseWatchState(value: unknown): WatchState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "http" && typeof raw.status === "number") {
    return {
      kind: "http",
      status: raw.status,
      hash: typeof raw.hash === "string" ? raw.hash : null,
      hasIncludes: raw.hasIncludes === true,
    };
  }
  if (raw.kind === "file") {
    return {
      kind: "file",
      mtimeMs: typeof raw.mtimeMs === "number" ? raw.mtimeMs : null,
      hash: typeof raw.hash === "string" ? raw.hash : null,
    };
  }
  if (raw.kind === "command" && typeof raw.exitCode === "number") {
    return {
      kind: "command",
      exitCode: raw.exitCode,
      hasIncludes: raw.hasIncludes === true,
    };
  }
  return undefined;
}
