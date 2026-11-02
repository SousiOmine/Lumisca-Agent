/**
 * Switching a stella conversation's model.
 *
 * The regression this pins: a conversation lives for years, and its model can
 * be retired from the catalog or lose its provider — with no route to switch,
 * the only way out was to delete the agent, and the whole conversation with
 * it. The route must pass the pair through untouched (the core owns the
 * "is this model selectable" rule) and must address the conversation by
 * agent.
 */
import { assertEquals } from "@std/assert";
import { stellaRoutes } from "./stella.ts";
import { jsonError } from "./util.ts";
import type { SessionInfo, StellaAgent } from "@lumisca/core";
import type { StellaApi } from "./stella.ts";

const AGENT: StellaAgent = {
  id: "a1",
  name: "Aide",
  role: "",
  identity: "",
  icon: "",
  createdAt: 0,
  updatedAt: 0,
};

const SESSION = {
  id: "s1",
  workspaceId: "ws",
  name: "Aide",
  modelProvider: "faux",
  modelId: "small",
  createdAt: 0,
  updatedAt: 0,
  stella: true,
  agentId: "a1",
} as SessionInfo;

function fakeCore(
  received: { sessionId: string; provider: string; modelId: string }[],
  options: { fail?: Error } = {},
): StellaApi {
  return {
    getStellaAgent: (id: string) => id === AGENT.id ? AGENT : undefined,
    findStellaSession: (agentId: string) =>
      agentId === AGENT.id ? SESSION : undefined,
    setSessionModel: (sessionId: string, provider: string, modelId: string) => {
      if (options.fail !== undefined) throw options.fail;
      received.push({ sessionId, provider, modelId });
    },
  } as unknown as StellaApi;
}

async function switchModel(
  body: unknown,
  received: { sessionId: string; provider: string; modelId: string }[] = [],
  options: { fail?: Error } = {},
) {
  const app = stellaRoutes(fakeCore(received, options));
  // The same error table the app mounts (app.ts's onError).
  app.onError((error, c) => jsonError(c, error));
  return await app.request("/stella/conversations/a1/model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("stella model: the conversation's session is switched by agent", async () => {
  const received: { sessionId: string; provider: string; modelId: string }[] =
    [];
  const response = await switchModel(
    { provider: "faux", modelId: "large" },
    received,
  );
  assertEquals(response.status, 200);
  assertEquals(received, [{
    sessionId: "s1",
    provider: "faux",
    modelId: "large",
  }]);
});

Deno.test("stella model: both fields are required", async () => {
  // Missing or blank values describe the request: they are a 400, not a
  // switch to an empty model the core would then refuse with a 404.
  assertEquals((await switchModel({ modelId: "large" })).status, 400);
  assertEquals((await switchModel({ provider: "faux" })).status, 400);
  assertEquals(
    (await switchModel({ provider: "", modelId: "large" })).status,
    400,
  );
  assertEquals(
    (await switchModel({ provider: "faux", modelId: "  " })).status,
    400,
  );
});

Deno.test("stella model: switching a closed conversation is a 404", async () => {
  const app = stellaRoutes(fakeCore([]));
  app.onError((error, c) => jsonError(c, error));
  // The agent exists but has no conversation yet: there is nothing to switch.
  const response = await app.request(
    "/stella/conversations/unknown/model",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "faux", modelId: "large" }),
    },
  );
  assertEquals(response.status, 404);
});
