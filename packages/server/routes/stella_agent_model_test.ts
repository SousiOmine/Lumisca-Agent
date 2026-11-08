/**
 * Choosing an agent's model from its edit dialog.
 *
 * The regression this pins: the model used to be settable only from the
 * settings dialog, which offered it only while a conversation was open — a
 * dead end for an agent nobody had opened yet. The choice belongs to the
 * agent now, and the route must pass it through untouched (`null` for the
 * app's default, an absent key for "leave it"), because the core owns the
 * rule for whether the model can be selected at all.
 */
import { assertEquals } from "@std/assert";
import { stellaRoutes } from "./stella.ts";
import { jsonError } from "./util.ts";
import type { StellaAgent } from "@lumisca/core";
import type { StellaApi } from "./stella.ts";

const AGENT: StellaAgent = {
  id: "a1",
  name: "Aide",
  role: "",
  identity: "",
  icon: "",
  model: null,
  createdAt: 0,
  updatedAt: 0,
};

interface Received {
  id: string;
  patch: {
    name?: string;
    icon?: unknown;
    model?: { provider: string; modelId: string } | null;
  };
}

function fakeCore(received: Received[]): StellaApi {
  return {
    updateStellaAgent: (
      id: string,
      patch: Received["patch"],
    ) => {
      received.push({ id, patch });
      return Promise.resolve({ ...AGENT, ...patch, icon: "" });
    },
  } as unknown as StellaApi;
}

async function patch(body: unknown, received: Received[]) {
  const app = stellaRoutes(fakeCore(received));
  // The same error table the app mounts (app.ts's onError): a route mounted
  // on its own would otherwise answer Hono's default 500 for an AppError.
  app.onError((error, c) => jsonError(c, error));
  return await app.request("/stella/agents/a1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("agent model: a chosen model reaches the core as one pair", async () => {
  const received: Received[] = [];
  const response = await patch(
    { model: { provider: "faux", modelId: "large" } },
    received,
  );
  assertEquals(response.status, 200);
  assertEquals(received[0]?.patch.model, {
    provider: "faux",
    modelId: "large",
  });
});

Deno.test("agent model: null asks for the app's default model", async () => {
  // Clearing the choice is a change like any other, so it must travel: an
  // absent key would mean "leave the chosen model alone".
  const received: Received[] = [];
  assertEquals((await patch({ model: null }, received)).status, 200);
  assertEquals(received[0]?.patch.model, null);
});

Deno.test("agent model: an absent key leaves the choice alone", async () => {
  const received: Received[] = [];
  assertEquals((await patch({ name: "Renamed" }, received)).status, 200);
  assertEquals(received[0]?.patch.model, undefined);
  assertEquals(received[0]?.patch.name, "Renamed");
});

Deno.test("agent model: a malformed pair is a 400, not a stored row", async () => {
  const received: Received[] = [];
  // A string, a missing half and a blank half all describe the request
  // wrongly: none of them names a model, and the core never sees them.
  assertEquals((await patch({ model: "faux/large" }, received)).status, 400);
  assertEquals(
    (await patch({ model: { modelId: "large" } }, received)).status,
    400,
  );
  assertEquals(
    (await patch({ model: { provider: "faux", modelId: "  " } }, received))
      .status,
    400,
  );
  assertEquals(received, []);
});
