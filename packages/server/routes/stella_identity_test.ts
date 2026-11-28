/**
 * The identity editor's two routes.
 *
 * The dialog loads the stored text before it shows a field, and saves the
 * whole text back: a GET that answered a summary, or a PUT that merged one
 * field, would leave the editor unable to tell what it is replacing.
 */
import { test } from "bun:test";
import type { StellaAgent } from "@lumisca/core";
import { assertEquals } from "@std/assert";
import { stellaRoutes } from "./stella.ts";
import { stellaApiStub } from "./test-stubs.ts";
import { jsonError } from "./util.ts";

function agent(identity: string): StellaAgent {
  return {
    id: "a1",
    name: "Aide",
    role: "",
    identity,
    icon: "",
    model: null,
    onboardedAt: null,
    disabledAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The routes, with a core that answers only for the fixture agent and
 * records the writes it is asked to make. */
function app(writes: string[], identity = "I keep the ledger.") {
  const routes = stellaRoutes(
    stellaApiStub({
      getStellaAgent: (id) => (id === "a1" ? agent(identity) : undefined),
      setStellaAgentIdentity: (id, content) => {
        writes.push(`${id}:${content}`);
        return agent(content);
      },
    }),
  );
  routes.onError((error, c) => jsonError(c, error));
  return routes;
}

test("identity: the stored text is what the editor loads", async () => {
  const response = await app([]).request("/stella/agents/a1/identity");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { identity: "I keep the ledger." });
});

test("identity: an agent that is gone is a 404, not an empty text", async () => {
  // An empty answer would let the dialog save over a note it never read.
  const response = await app([]).request("/stella/agents/nope/identity");
  assertEquals(response.status, 404);
});

test("identity: the whole text is replaced with what the user typed", async () => {
  const writes: string[] = [];
  const response = await app(writes).request("/stella/agents/a1/identity", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: "I keep the ledger and the receipts." }),
  });
  assertEquals(response.status, 200);
  assertEquals(writes, ["a1:I keep the ledger and the receipts."]);
  const saved = (await response.json()) as StellaAgent;
  assertEquals(saved.identity, "I keep the ledger and the receipts.");
});

test("identity: an empty body clears it", async () => {
  // PUT replaces what is stored; an absent field therefore means the empty
  // text, the same thing the editor's empty field sends.
  const writes: string[] = [];
  const response = await app(writes).request("/stella/agents/a1/identity", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(response.status, 200);
  assertEquals(writes, ["a1:"]);
});

test("identity: a non-string field is a 400, not a coerced text", async () => {
  const response = await app([]).request("/stella/agents/a1/identity", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: 42 }),
  });
  assertEquals(response.status, 400);
});
