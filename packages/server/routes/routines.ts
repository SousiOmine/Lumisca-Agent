/**
 * The routine API.
 *
 * The UI never creates or edits a routine's text — that is the agent's job
 * (the `routine_*` tools), because the request and the name are things the
 * user said in a conversation. What the settings screen does is look at the
 * list and act on it: turn one off, delete it, run it now, stop a run. Those
 * four are exactly the routes here.
 *
 * Every mutation answers with the list of the agent's routines, so the client
 * replaces its view wholesale instead of keeping a diff in step.
 */

import type { Routine, StellaAgent } from "@lumisca/core";
import {
  nextRunAt,
  paths,
  type RoutineView,
  routePath,
} from "@lumisca/core/shared";
import { Hono } from "hono";
import { AppError, notFound, parseBody, requireBoolean } from "./util.ts";

/** The scheduler's surface (`core.routines`), declared by its method names
 * rather than restated: the route is handed the service itself, so a rename
 * there fails the type check here instead of drifting inside a closure. */
export interface RoutineSource {
  listOf(agentId: string): Routine[];
  isRunning(id: string): boolean;
  isQueued(id: string): boolean;
  runNow(id: string): Promise<void>;
  stop(id: string): void;
  getRoutineRepo(): {
    get(id: string): Routine | undefined;
    update(
      id: string,
      patch: { enabled?: boolean; nextRunAt?: number | null },
    ): Routine;
    delete(id: string): boolean;
  };
}

/** The agents a routine belongs to: `core.services.stellaAgents`. */
export interface RoutineAgents {
  listStellaAgents(): StellaAgent[];
}

/**
 * The routine routes.
 *
 * Scoped by agent: `/stella/agents/:agentId/routines`. A routine belongs to
 * one agent's conversation, so the agent id is part of the address instead of
 * a field in the body — an operation cannot then address a routine of a
 * conversation the user is not looking at.
 */
export function routineRoutes(
  routines: RoutineSource,
  agents: RoutineAgents,
): Hono {
  const app = new Hono();

  /** The list of one agent's routines, newest last (creation order), with
   * the scheduling flags from the scheduler: `running` (the prompt reached
   * the agent) and `queued` (it is waiting for the conversation). */
  const listOf = (agentId: string): { routines: RoutineView[] } => {
    const agent = agents.listStellaAgents().find((item) => item.id === agentId);
    if (agent === undefined) {
      throw notFound("Agent", agentId);
    }
    return {
      routines: routines.listOf(agentId).map((routine) => ({
        ...routine,
        agentName: agent.name,
        running: routines.isRunning(routine.id),
        queued: routines.isQueued(routine.id),
      })),
    };
  };

  /** The routine's agent, so a route addressed by routine id can answer
   * with the right list. */
  const agentOf = (routineId: string): string => {
    const routine = routines.getRoutineRepo().get(routineId);
    if (routine === undefined) {
      throw notFound("Routine", routineId);
    }
    return routine.agentId;
  };

  app.get(routePath(paths.stellaAgentRoutines), (c) => {
    return c.json(listOf(c.req.param("agentId")));
  });

  /** Turn a routine on or off. Enabling schedules the next run from now;
   * disabling clears it (a disabled routine must not fire because of a
   * stale next-run value). */
  app.patch(routePath(paths.routine), async (c) => {
    const body = await parseBody<{ enabled?: unknown }>(c);
    const enabled = requireBoolean(body?.enabled, "enabled");
    const id = c.req.param("id");
    const repo = routines.getRoutineRepo();
    const routine = repo.get(id);
    if (routine === undefined) {
      throw notFound("Routine", id);
    }
    repo.update(id, {
      enabled,
      nextRunAt: enabled ? nextRunAt(routine.schedule, Date.now()) : null,
    });
    return c.json(listOf(routine.agentId));
  });

  app.delete(routePath(paths.routine), (c) => {
    const id = c.req.param("id");
    const agentId = agentOf(id);
    routines.getRoutineRepo().delete(id);
    return c.json(listOf(agentId));
  });

  /** Run it now. Deliberately not awaited: a run is a whole turn, and the
   * settings list must not hold a request open for it.
   *
   * A disabled agent's routine is refused before it is queued: there is no
   * conversation to run in, and the scheduler would record a skip the user
   * did not ask for. This is an answer to the button, so it is a 409 rather
   * than a row note. */
  app.post(routePath(paths.routineRun), (c) => {
    const id = c.req.param("id");
    const agentId = agentOf(id);
    const agent = agents.listStellaAgents().find((item) => item.id === agentId);
    if (agent !== undefined && agent.disabledAt !== null) {
      throw new AppError(`Agent ${agentId} is disabled`, 409);
    }
    void routines.runNow(id).catch(() => {
      // The failure is recorded on the routine's row and shown by the list.
    });
    return c.json(listOf(agentId));
  });

  /** Stop the run this routine started. A run the user started in the same
   * conversation is left alone (the core checks the run's origin). */
  app.post(routePath(paths.routineStop), (c) => {
    const id = c.req.param("id");
    const agentId = agentOf(id);
    routines.stop(id);
    return c.json(listOf(agentId));
  });

  return app;
}
