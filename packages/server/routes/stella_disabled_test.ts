/**
 * A switched-off agent's HTTP surface.
 *
 * Three rules are worth pinning here, because each one keeps a different
 * promise: the patch passes `enabled` through untouched (the row is the
 * core's business), the conversation is served READ-ONLY without opening
 * anything (no machine start, no agent built), and the routes that would
 * make the agent do something refuse with 409 instead of quietly accepting.
 */
import { test } from "bun:test";
import type { SessionInfo, StellaAgent } from "@lumisca/core";
import { assertEquals } from "@std/assert";
import type { StellaApi } from "./stella.ts";
import { stellaRoutes } from "./stella.ts";
import { stellaApiStub } from "./test-stubs.ts";
import { jsonError } from "./util.ts";

function agent(overrides: Partial<StellaAgent> = {}): StellaAgent {
  return {
    id: "a1",
    name: "Aide",
    role: "",
    identity: "",
    icon: "",
    model: null,
    onboardedAt: null,
    disabledAt: 1_700_000_000_000,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function session(): SessionInfo {
  return {
    id: "s1",
    mainAgentId: "a1",
    workspaceId: "w1",
    name: "Aide",
    modelProvider: "faux",
    modelId: "faux-1",
    thinkingLevel: "off",
    stella: true,
    personaId: "a1",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A core whose "open" throws: a read of a disabled conversation must never
 * reach it. Every other stub is what the read-only snapshot touches. */
function readOnlyCore(calls: string[]): StellaApi {
  return stellaApiStub({
    getStellaAgent: () => agent(),
    findStellaSession: () => session(),
    readStellaConversationFromStore: (id, query) => {
      calls.push(`store:${id}:${query.older ?? ""}`);
      return { items: [], older: null };
    },
    getThinkingState: () => ({ thinkingLevel: "off", thinkingLevels: [] }),
    getSessionRevision: () => 0,
  });
}

function app(core: StellaApi) {
  const routes = stellaRoutes(core);
  // The same error table the app mounts (app.ts's onError), so a 409 here is
  // the status the browser would see.
  routes.onError((error, c) => jsonError(c, error));
  return routes;
}

test("disabled agent: the switch reaches the core untouched", async () => {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const core = stellaApiStub({
    updateStellaAgent: (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch });
      return Promise.resolve(agent({ ...patch, disabledAt: 1 }));
    },
  });
  const response = await app(core).request("/stella/agents/a1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assertEquals(response.status, 200);
  assertEquals(patches[0]?.id, "a1");
  assertEquals(patches[0]?.patch.enabled, false);
  assertEquals((await response.json()).disabledAt, 1);
});

test("disabled agent: a non-boolean switch is a 400, not silence", async () => {
  const core = stellaApiStub({
    updateStellaAgent: () => Promise.resolve(agent()),
  });
  const response = await app(core).request("/stella/agents/a1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: "off" }),
  });
  assertEquals(response.status, 400);
});

test("disabled agent: opening the conversation reads the store, not the core's open", async () => {
  // `getOrCreateStellaSession` is absent from the stub on purpose: the stub
  // throws for any method it was not given, so reaching it would fail here.
  const calls: string[] = [];
  const response = await app(readOnlyCore(calls)).request(
    "/stella/conversations/a1",
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.disabled, true);
  assertEquals(body.sessionId, "s1");
  assertEquals(body.running, false);
  assertEquals(calls, ["store:s1:"]);
});

test("disabled agent: a conversation that was never opened has no session", async () => {
  const core = stellaApiStub({
    getStellaAgent: () => agent(),
    findStellaSession: () => undefined,
  });
  const response = await app(core).request("/stella/conversations/a1");
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.disabled, true);
  // No row, no assets to address, and no model to show: the row is created
  // when the agent is switched on and opened.
  assertEquals(body.sessionId, null);
  assertEquals(body.model, null);
  assertEquals(body.entries, []);
});

test("disabled agent: sending is refused before the machine is touched", async () => {
  const core = stellaApiStub({
    getStellaAgent: () => agent(),
    // `ensureStellaReady` and `startPrompt` are absent: the stub throws for
    // them, so a route that reached either would fail this test.
  });
  const response = await app(core).request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assertEquals(response.status, 409);
});

test("disabled agent: the clipboard is refused, reading included", async () => {
  const core = stellaApiStub({
    getStellaAgent: () => agent(),
  });
  const response = await app(core).request(
    "/stella/conversations/a1/clipboard",
  );
  // Reading the clipboard goes through the machine, which a disabled agent
  // must not start. (The reply is a WebSocket upgrade answer only on the
  // events route; this one is an ordinary JSON route.)
  assertEquals(response.status, 409);
});

test("disabled agent: the event stream closes at once", async () => {
  const core = stellaApiStub({
    getStellaAgent: () => agent(),
  });
  // The upgrade itself is answered by the adapter; what matters here is that
  // the handler never asks for the conversation, which the stub would throw
  // on. A 200/101 answer either way is fine — the socket closes on open.
  const response = await app(core).request("/stella/conversations/a1/events");
  assertEquals(response.status < 500, true);
});
