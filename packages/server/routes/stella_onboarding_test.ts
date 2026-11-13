import type { SessionInfo, StellaAgent } from "@lumisca/core";
/**
 * The setup turn's two entry points.
 *
 * Opening a conversation may start the app's first turn (the agent asks how
 * it should work); the core decides whether it is due, with a claim that only
 * one caller can take. The routes' job is only to offer both moments: the
 * first open, and the row menu's "set up again".
 */
import { assertEquals } from "@std/assert";
import type { StellaApi } from "./stella.ts";
import { stellaRoutes } from "./stella.ts";
import { stellaApiStub } from "./test-stubs.ts";
import { jsonError } from "./util.ts";

function session(): SessionInfo {
  return {
    id: "s1",
    workspaceId: "w1",
    name: "Aide",
    modelProvider: "faux",
    modelId: "faux-1",
    thinkingLevel: "off",
    stella: true,
    agentId: "a1",
    createdAt: 0,
    updatedAt: 0,
  };
}

function agent(): StellaAgent {
  return {
    id: "a1",
    name: "Aide",
    role: "Help.",
    identity: "",
    icon: "",
    model: null,
    onboardedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A core that records the two setup calls and answers the snapshot the open
 * route reads. Everything the snapshot touches is stubbed because it all runs
 * on the same request: a missing method here would be a 500, not a setup. */
function fakeCore(calls: string[], started: boolean): StellaApi {
  return stellaApiStub({
    getOrCreateStellaSession: () => Promise.resolve(session()),
    startStellaOnboarding: (agentId: string) => {
      calls.push(`start ${agentId}`);
      return started;
    },
    restartStellaOnboarding: (agentId: string) => {
      calls.push(`restart ${agentId}`);
      return started;
    },
    readStellaConversation: () => ({ items: [], older: null }),
    getAgent: () => ({ isStreaming: false }),
    getPendingQuestions: () => [],
    getPendingHandover: () => null,
    getPendingEnvRequest: () => null,
    getPendingShareRequest: () => null,
    finishShareLend: () => {},
    declineShareRequest: () => {},
    finishShareDisconnect: () => {},
    failShareDisconnect: () => {},
    getShares: () => [],
    getSessionLastError: () => undefined,
    getStellaAgent: () => agent(),
    getThinkingState: () => ({ thinkingLevel: "off", thinkingLevels: [] }),
    getSessionRevision: () => 0,
  });
}

function app(calls: string[], started = true) {
  const routes = stellaRoutes(fakeCore(calls, started));
  // The error table the app mounts: an AppError mounted alone would answer
  // Hono's default 500.
  routes.onError((error, c) => jsonError(c, error));
  return routes;
}

Deno.test("stella onboarding route: opening a conversation offers the setup turn", async () => {
  const calls: string[] = [];
  const response = await app(calls).request("/stella/conversations/a1");
  assertEquals(response.status, 200);
  assertEquals(calls, ["start a1"]);
});

Deno.test("stella onboarding route: the row menu's redo restarts it", async () => {
  const calls: string[] = [];
  const response = await app(calls).request("/stella/agents/a1/onboarding", {
    method: "POST",
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { started: true });
  // Opening first is what brings the machine up; the restart is what asks
  // the questions.
  assertEquals(calls, ["restart a1"]);
});

Deno.test("stella onboarding route: a refused restart is answered, not hidden", async () => {
  // The core refuses while the conversation is running (setup text must not
  // be steered into someone's work). The client needs that answer to say so
  // instead of showing a screen where nothing happened.
  const calls: string[] = [];
  const response = await app(calls, false).request(
    "/stella/agents/a1/onboarding",
    { method: "POST" },
  );
  assertEquals(await response.json(), { started: false });
});
