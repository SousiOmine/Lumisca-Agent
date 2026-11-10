import { stellaApiStub } from "./test-stubs.ts";
/**
 * What an agent's edit dialog saves besides its name and picture: the model
 * its conversation runs on, and the thinking strength of that model.
 *
 * The regression the model half pins: it used to be settable only from the
 * settings dialog, which offered it only while a conversation was open — a
 * dead end for an agent nobody had opened yet. The choice belongs to the
 * agent now, and the route must pass it through untouched (`null` for the
 * app's default, an absent key for "leave it"), because the core owns the
 * rule for whether the model can be selected at all.
 *
 * The level travels with the model it belongs to, for the same reason: the
 * dialog drew the list from one model, and the core must store it there.
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
  onboardedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

interface Received {
  id: string;
  patch: {
    name?: string;
    icon?: unknown;
    model?: { provider: string; modelId: string } | null;
    thinkingLevel?: { provider: string; modelId: string; level: string };
  };
}

function fakeCore(received: Received[]): StellaApi {
  return stellaApiStub({
    updateStellaAgent: (
      id: string,
      patch: Received["patch"],
    ) => {
      received.push({ id, patch });
      return Promise.resolve({
        ...AGENT,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
      });
    },
  });
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

Deno.test("agent thinking level: the level travels with the model it is for", async () => {
  // The level is a MODEL setting, so the request names the model instead of
  // letting the server re-resolve "the agent's model" (the two could
  // disagree when the default model changed while the dialog was open).
  const received: Received[] = [];
  const response = await patch(
    {
      thinkingLevel: { provider: "faux", modelId: "large", level: "high" },
    },
    received,
  );
  assertEquals(response.status, 200);
  assertEquals(received[0]?.patch.thinkingLevel, {
    provider: "faux",
    modelId: "large",
    level: "high",
  });
});

Deno.test("agent thinking level: an absent key leaves the stored level alone", async () => {
  const received: Received[] = [];
  assertEquals((await patch({ name: "Renamed" }, received)).status, 200);
  assertEquals(received[0]?.patch.thinkingLevel, undefined);
});

Deno.test("agent thinking level: a malformed level is a 400, not a stored row", async () => {
  // A save is one act: a level the route cannot read must not reach the core
  // next to the name it would otherwise store.
  const received: Received[] = [];
  const bodies = [
    { thinkingLevel: "high" },
    { thinkingLevel: { provider: "faux", modelId: "large" } },
    { thinkingLevel: { provider: "faux", modelId: "large", level: "" } },
    { thinkingLevel: { provider: "  ", modelId: "large", level: "high" } },
    { thinkingLevel: { provider: "faux", level: "high" } },
  ];
  for (const body of bodies) {
    assertEquals(
      (await patch(body, received)).status,
      400,
      JSON.stringify(body),
    );
  }
  assertEquals(received, []);
});
