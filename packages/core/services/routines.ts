import type { SessionPool } from "../agent/pool.ts";
import type { SessionInfo } from "../domain/session.ts";
import { CoreError } from "../errors.ts";
import type { McpService } from "../mcp/service.ts";
import { checkRoutine } from "../routine/check.ts";
import type { RoutineRepo } from "../routine/repo.ts";
import type {
  RoutineRunner,
  RoutineScheduler,
  RoutineTrigger,
} from "../routine/scheduler.ts";
import type { SessionRepo } from "../session/repo.ts";
import { formatLocalDateTime } from "../shared/mod.ts";
import type { Routine } from "../shared/routine.ts";
import type { StellaAgentRepo } from "../stella/agents.ts";
import type { StellaRuntime } from "../vm/runtime.ts";

/** What the routine service reads from the facade that owns it. The few
 * functions are the ones that cross another service: opening a conversation
 * and waking its machine belong to the session and stella services. */
export interface RoutineServiceDeps {
  repo: RoutineRepo;
  scheduler: RoutineScheduler;
  sessions: SessionRepo;
  stellaAgents: StellaAgentRepo;
  pool: SessionPool;
  mcp: McpService;
  ensureStellaReady(agentId: string): Promise<void>;
  ensureStellaSkills(agentId: string): Promise<void>;
  openSession(id: string): SessionInfo;
  stellaRuntimeFor(session: SessionInfo): StellaRuntime | undefined;
}

/**
 * The scheduled requests of stella conversations.
 *
 * The scheduler decides when a routine is due; this service is its seam into
 * the conversations: whether an agent may run, how a run starts, how it is
 * stopped, and whether a watch check found anything. It also owns the list
 * the settings screen reads.
 */
export class RoutineService {
  readonly #deps: RoutineServiceDeps;

  constructor(deps: RoutineServiceDeps) {
    this.#deps = deps;
  }

  /** The routine repository (the settings list reads it). */
  getRoutineRepo(): RoutineRepo {
    return this.#deps.repo;
  }

  /** Start the routine scheduler. The server calls this once the rest of the
   * app is up; tests drive `runNow` / a short tick instead. */
  start(): void {
    this.#deps.scheduler.start();
  }

  /** Stop the scheduler and wait for a tick already in flight. */
  close(): void {
    this.#deps.scheduler.close();
  }

  /** Whether a run of this routine is in flight (the settings list's
   * "running now"). Never persisted: it describes this process. A queued run
   * counts as in flight — its prompt is going to run — and `isQueued` says
   * whether that is what it is doing. */
  isRunning(id: string): boolean {
    return this.#deps.scheduler.isRunning(id);
  }

  /** Whether this routine's run is still waiting for its conversation to be
   * free (the settings list draws it apart from "running"). */
  isQueued(id: string): boolean {
    return this.#deps.scheduler.isQueued(id);
  }

  /** Run a routine now, without moving its schedule. Resolves when the run
   * finished (the HTTP route does not wait — see routes). */
  runNow(id: string): Promise<void> {
    return this.#deps.scheduler.runNow(id);
  }

  /** Stop a running routine's run. Only the run this routine started is
   * interrupted; a user's own run in the same conversation is left alone. */
  stop(id: string): void {
    this.#deps.scheduler.stop(id);
  }

  /** The routines of one agent, oldest first (the settings list, the tool
   * list). */
  listOf(agentId: string): Routine[] {
    return this.#deps.repo.listOf(agentId);
  }

  /** The scheduler's seam into the sessions: start a routine's run in its
   * agent's conversation and wait for it, and stop the run it started. */
  runner(): RoutineRunner {
    const deps = this.#deps;
    return {
      isRunning: (agentId) => {
        const session = deps.sessions.getByPersona(agentId);
        if (session === undefined) return false;
        const agent = deps.pool.get(session.id);
        return agent !== undefined && agent.isStreaming;
      },
      isAgentEnabled: (agentId) => {
        const agent = deps.stellaAgents.get(agentId);
        return agent !== undefined && agent.disabledAt === null;
      },
      run: async (agentId, prompt, routine, trigger) => {
        const owner = deps.stellaAgents.get(agentId);
        if (owner === undefined || owner.disabledAt !== null) {
          // The agent was switched off after this run was queued. Opening
          // its conversation would undo the release the disable performed
          // (see openSession), so the run is refused rather than run into a
          // conversation the user cannot see.
          throw new CoreError(`Agent ${agentId} is disabled`, "conflict");
        }
        const session = deps.sessions.getByPersona(agentId);
        if (session === undefined) {
          // The agent exists but its conversation was never opened, or it
          // was deleted while the run was queued: opening it here would
          // resurrect a deleted agent's row, so this is a real failure.
          throw new CoreError(
            `No conversation to run the routine in (agent ${agentId})`,
            "not_found",
          );
        }
        // A routine runs in a conversation that is already open, so nothing
        // on this path would otherwise ask whether the machine is up: a
        // machine that died since (a crash, a stop from outside) answered
        // every tool with podman's "container state improper" until the user
        // happened to open the conversation again.
        if (session.stella === true) {
          const agentId = session.personaId;
          if (agentId === undefined) {
            throw new CoreError(
              "The stella session has no agent: its machine cannot be woken",
              "invalid",
            );
          }
          await deps.ensureStellaReady(agentId);
          // Opening a conversation is what primes its skill catalog, and a
          // routine opens one with the synchronous `openSession`: without
          // this read the run builds its agent from an empty cache and the
          // conversation is told it has no skills. Nothing read them again
          // while the conversation stayed open, so after a server restart
          // the routine-only conversations kept running without a catalog.
          // The same read is needed after idle sleep woke the machine: the
          // catalog is only read while the machine is up (see
          // StellaMachine.ensureSkills).
          await deps.ensureStellaSkills(agentId);
        }
        await deps.openSession(session.id);
        const agent = deps.pool.require(session.id);
        deps.sessions.touch(session.id);
        return await agent.runRoutine(withTrigger(prompt, trigger), {
          id: routine.id,
          name: routine.name,
        });
      },
      stop: (agentId, routineId) => {
        const session = deps.sessions.getByPersona(agentId);
        if (session === undefined) return;
        const agent = deps.pool.get(session.id);
        if (agent === undefined) return;
        // Only the run this routine started is stopped: a run the user
        // started in the same conversation must not be cut by a routine's
        // stop button.
        if (agent.runningRoutineId() !== routineId) return;
        agent.abort();
      },
      check: async (routine) => {
        const session = deps.sessions.getByPersona(routine.agentId);
        if (session === undefined) {
          return {
            kind: "unsupported",
            problem:
              "This agent has no conversation, so its checks have nowhere to run",
          };
        }
        // The machine-bound sources run inside the machine, in the agent's
        // own folder (see routine/check.ts); an MCP check goes through the
        // server's own connection to that server, which is the one the agent
        // calls through, so it works while the machine is down.
        const stella = deps.stellaRuntimeFor(session);
        return await checkRoutine(routine, {
          ...(stella === undefined
            ? {}
            : {
                machine: {
                  runner: stella.runner,
                  files: stella.files,
                  workdir: stella.cwd,
                },
              }),
          callTool: (server, tool, args, signal) =>
            deps.mcp.callToolForCheck(server, tool, args, signal),
        });
      },
    };
  }
}

/** Prepend a watch check's observation to the prompt of the run it started.
 *
 * The line is for the model, not the user: it says the run began because a
 * check that fired it found new items, and when. Without it the model would
 * have to call the check again to learn what happened, and could see nothing
 * new because the check had already consumed the difference.
 *
 * Routine prompts are not drawn in the transcript (see stella-state.ts), so
 * the line changes nothing the user sees. It saves the run an MCP call whose
 * only purpose would be learning how much happened, and it keeps an item
 * from being missed when the user read the same list between the check and
 * the run.
 *
 * A scheduled run gets the prompt alone: nothing fired it but the clock. */
function withTrigger(prompt: string, trigger?: RoutineTrigger): string {
  if (trigger === undefined) return prompt;
  return (
    `${trigger.newItems} new item(s) appeared at ${formatLocalDateTime(
      trigger.at,
    )}, and the routine's watch check started this run with that observation.\n\n` +
    prompt
  );
}
