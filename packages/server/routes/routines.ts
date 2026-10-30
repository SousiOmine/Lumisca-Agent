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
import { Hono } from "hono";
import type { Routine, StellaAgent } from "@lumisca/core";
import { AppError, parseBody, requireBoolean } from "./util.ts";

/** One routine as the settings list shows it: the stored row plus whether it
 * is running right now (which lives in the scheduler, not the database). */
export interface RoutineView extends Routine {
  agentName: string;
  running: boolean;
}

export interface RoutineApi {
  listRoutinesOf(agentId: string): Routine[];
  isRoutineRunning(id: string): boolean;
  runRoutineNow(id: string): Promise<void>;
  stopRoutine(id: string): void;
  getRoutineRepo(): {
    get(id: string): Routine | undefined;
    update(
      id: string,
      patch: { enabled?: boolean; nextRunAt?: number | null },
    ): Routine;
    delete(id: string): boolean;
  };
  listStellaAgents(): StellaAgent[];
  /** The next-run rule (shared with the core so the client's toggle and the
   * scheduler agree about when a routine fires). */
  nextRoutineRun(
    schedule: Routine["schedule"],
    from: number,
  ): number;
}

/**
 * The routine routes.
 *
 * Scoped by agent: `/stella/agents/:agentId/routines`. A routine belongs to
 * one agent's conversation, so the agent id is part of the address instead of
 * a field in the body — an operation cannot then address a routine of a
 * conversation the user is not looking at.
 */
export function routineRoutes(core: RoutineApi): Hono {
  const app = new Hono();

  /** The list of one agent's routines, newest last (creation order), with
   * the running flag from the scheduler. */
  const listOf = (agentId: string): { routines: RoutineView[] } => {
    const agent = core.listStellaAgents().find((item) => item.id === agentId);
    if (agent === undefined) {
      throw new AppError(`Agent not found: ${agentId}`, 404);
    }
    return {
      routines: core.listRoutinesOf(agentId).map((routine) => ({
        ...routine,
        agentName: agent.name,
        running: core.isRoutineRunning(routine.id),
      })),
    };
  };

  /** The routine's agent, so a route addressed by routine id can answer
   * with the right list. */
  const agentOf = (routineId: string): string => {
    const routine = core.getRoutineRepo().get(routineId);
    if (routine === undefined) {
      throw new AppError(`Routine not found: ${routineId}`, 404);
    }
    return routine.agentId;
  };

  app.get("/stella/agents/:agentId/routines", (c) => {
    return c.json(listOf(c.req.param("agentId")));
  });

  /** Turn a routine on or off. Enabling schedules the next run from now;
   * disabling clears it (a disabled routine must not fire because of a
   * stale next-run value). */
  app.patch("/routines/:id", async (c) => {
    const body = await parseBody<{ enabled?: unknown }>(c);
    const enabled = requireBoolean(body?.enabled, "enabled");
    const id = c.req.param("id");
    const repo = core.getRoutineRepo();
    const routine = repo.get(id);
    if (routine === undefined) {
      throw new AppError(`Routine not found: ${id}`, 404);
    }
    repo.update(id, {
      enabled,
      nextRunAt: enabled
        ? core.nextRoutineRun(routine.schedule, Date.now())
        : null,
    });
    return c.json(listOf(routine.agentId));
  });

  app.delete("/routines/:id", (c) => {
    const id = c.req.param("id");
    const agentId = agentOf(id);
    core.getRoutineRepo().delete(id);
    return c.json(listOf(agentId));
  });

  /** Run it now. Deliberately not awaited: a run is a whole turn, and the
   * settings list must not hold a request open for it. */
  app.post("/routines/:id/run", (c) => {
    const id = c.req.param("id");
    const agentId = agentOf(id);
    void core.runRoutineNow(id).catch(() => {
      // The failure is recorded on the routine's row and shown by the list.
    });
    return c.json(listOf(agentId));
  });

  /** Stop the run this routine started. A run the user started in the same
   * conversation is left alone (the core checks the run's origin). */
  app.post("/routines/:id/stop", (c) => {
    const id = c.req.param("id");
    const agentId = agentOf(id);
    core.stopRoutine(id);
    return c.json(listOf(agentId));
  });

  return app;
}
