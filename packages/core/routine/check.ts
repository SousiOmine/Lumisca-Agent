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
 * Every source but an MCP tool is answered FROM THE MACHINE (see
 * vm/watch.ts): the address, the file and the command are the agent's. An
 * MCP tool is answered by the server process's own connection — the one the
 * agent calls through — so that check runs whether or not the machine is up.
 */
import type { Routine } from "../shared/routine.ts";
import type { CommandRunner } from "../tools/command-backend.ts";
import type { FileBackend } from "../tools/file-backend.ts";
import { machineWatchFetch, parseWatchState, runWatch } from "../vm/watch.ts";
import type { WatchCheck } from "./scheduler.ts";

/** What a check needs. Both halves are optional because which one it needs
 * depends on the source; {@link checkRoutine} answers `unsupported` for the
 * one that is missing. */
export interface RoutineCheckDeps {
  /** The machine the file, command and HTTP checks run in. */
  machine?: {
    /** The machine's command runner: the file check, the command check and
     * curl all run there. */
    runner: CommandRunner;
    /** The machine's files: the HTTP body is written and read back through
     * them. */
    files: FileBackend;
    /** The agent's own folder: relative paths resolve here and curl starts
     * here. */
    workdir: string;
  };
  /** Call an MCP tool and return its text (see vm/watch.ts). */
  callTool?: (
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** The request, for a test. Production leaves this out and the request
   * goes out from the machine. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Run one watch routine's check and compare it with the observation stored
 * on the routine. A routine that watches nothing, or one whose check cannot
 * run here (the machine is down for the machine-bound sources), answers
 * `unsupported`. */
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
  const source = routine.schedule.source;
  const machine = deps.machine;
  if (source.kind === "mcp") {
    if (deps.callTool === undefined) {
      return {
        kind: "unsupported",
        problem: "This check has no MCP connection to call the tool through",
      };
    }
  } else if (machine === undefined) {
    return {
      kind: "unsupported",
      problem:
        "The machine for this agent is not running, so its checks cannot run",
    };
  }
  const previous =
    routine.watchState === undefined
      ? undefined
      : parseWatchState(routine.watchState);
  const outcome = await runWatch(source, previous, {
    ...(machine === undefined
      ? {}
      : {
          machine: { runner: machine.runner, workdir: machine.workdir },
        }),
    ...(deps.callTool === undefined ? {} : { callTool: deps.callTool }),
    ...(source.kind === "mcp" || machine === undefined
      ? {}
      : {
          fetch:
            deps.fetch ??
            machineWatchFetch({
              runner: machine.runner,
              files: machine.files,
              workdir: machine.workdir,
              ...(deps.signal === undefined ? {} : { signal: deps.signal }),
            }),
        }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (outcome.state === null) {
    return {
      kind: "error",
      problem: outcome.problem ?? "The check could not observe anything",
    };
  }
  if (!outcome.changed) return { kind: "same", state: outcome.state };
  return {
    kind: "changed",
    state: outcome.state,
    ...(outcome.newItems === undefined ? {} : { newItems: outcome.newItems }),
  };
}
