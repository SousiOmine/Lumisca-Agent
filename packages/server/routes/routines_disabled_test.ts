/**
 * "Run now" on a switched-off agent.
 *
 * The scheduler would refuse it too, but that refusal is recorded on the
 * routine's row, which is an answer to a tick rather than to a button. The
 * route therefore refuses first, with the status the settings list shows, so
 * the reader learns why nothing happened instead of watching a list that says
 * "skipped" by itself.
 */
import { test } from "bun:test";
import type { Routine, StellaAgent } from "@lumisca/core";
import { assertEquals } from "@std/assert";
import { type RoutineApi, routineRoutes } from "./routines.ts";
import { jsonError } from "./util.ts";

function routine(): Routine {
  return {
    id: "r1",
    agentId: "a1",
    name: "Check",
    prompt: "check it",
    schedule: { kind: "every", minutes: 30 },
    enabled: true,
    nextRunAt: 0,
    lastRunAt: null,
    lastStatus: null,
    lastDetail: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function agent(disabledAt: number | null): StellaAgent {
  return {
    id: "a1",
    name: "Aide",
    role: "",
    identity: "",
    icon: "",
    model: null,
    onboardedAt: null,
    disabledAt,
    createdAt: 0,
    updatedAt: 0,
  };
}

function core(disabledAt: number | null, runs: string[]): RoutineApi {
  return {
    listRoutinesOf: () => [routine()],
    isRoutineRunning: () => false,
    isRoutineQueued: () => false,
    runRoutineNow: (id) => {
      runs.push(id);
      return Promise.resolve();
    },
    stopRoutine: () => {},
    getRoutineRepo: () => ({
      get: (id) => (id === "r1" ? routine() : undefined),
      update: () => routine(),
      delete: () => false,
    }),
    listStellaAgents: () => [agent(disabledAt)],
    nextRoutineRun: () => 0,
  };
}

function run(disabledAt: number | null, runs: string[]) {
  const app = routineRoutes(core(disabledAt, runs));
  app.onError((error, c) => jsonError(c, error));
  return app.request("/routines/r1/run", { method: "POST" });
}

test("routines: a disabled agent's run is refused and not queued", async () => {
  const runs: string[] = [];
  const response = await run(1_700_000_000_000, runs);
  assertEquals(response.status, 409);
  // Nothing was started: the user can switch the agent on and press again.
  assertEquals(runs, []);
});

test("routines: an enabled agent's run is started", async () => {
  const runs: string[] = [];
  const response = await run(null, runs);
  assertEquals(response.status, 200);
  assertEquals(runs, ["r1"]);
});
