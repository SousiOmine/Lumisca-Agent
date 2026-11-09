/**
 * One `watch` check, as the scheduler asks for it.
 *
 * The previous observation belongs to the ROUTINE, not to the source it
 * watches: two routines may watch the same file, and a stored value is a
 * fresh object on every read (repo.ts rebuilds it from JSON), so a caller
 * that looks the routine up again by its source either finds nothing or
 * finds another routine's baseline. That is why the runner is handed the
 * routine itself.
 *
 * The request goes out FROM THE MACHINE (see vm/watch.ts): the address is
 * the one the agent can reach. A check the host could make but the agent
 * could not would report a change the agent cannot act on, and the reverse
 * (a machine-local service) would go unwatched.
 */
import type { Routine } from "../shared/routine.ts";
import type { CommandRunner } from "../tools/command-backend.ts";
import type { FileBackend } from "../tools/file-backend.ts";
import { machineWatchFetch, parseWatchState, runWatch } from "../vm/watch.ts";
import type { WatchCheck } from "./scheduler.ts";

/** What a check needs from the machine the routine's agent owns. */
export interface RoutineCheckDeps {
  /** The machine's command runner: the file check, the command check and
   * curl all run there. */
  runner: CommandRunner;
  /** The machine's files: the HTTP body is written and read back through
   * them. */
  files: FileBackend;
  /** The agent's own folder: relative paths resolve here and curl starts
   * here. */
  workdir: string;
  /** The request, for a test. Production leaves this out and the request
   * goes out from the machine. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Run one watch routine's check and compare it with the observation stored
 * on the routine. A routine that watches nothing answers `unsupported`. */
export async function checkRoutine(
  routine: Routine,
  deps: RoutineCheckDeps,
): Promise<WatchCheck> {
  if (routine.schedule.kind !== "watch") {
    return {
      kind: "unsupported",
      problem: "This routine has no watch, so it has nothing to check",
    };
  }
  const previous = routine.watchState === undefined
    ? undefined
    : parseWatchState(routine.watchState);
  const outcome = await runWatch(routine.schedule.source, previous, {
    runner: deps.runner,
    workdir: deps.workdir,
    fetch: deps.fetch ??
      machineWatchFetch({
        runner: deps.runner,
        files: deps.files,
        workdir: deps.workdir,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (outcome.state === null) {
    return {
      kind: "error",
      problem: outcome.problem ?? "The check could not observe anything",
    };
  }
  return outcome.changed
    ? { kind: "changed", state: outcome.state }
    : { kind: "same", state: outcome.state };
}
