/**
 * Creating an agent with an empty form. The regression this pins: the form's
 * two free-text answers were required, and the server's route refused an
 * empty `name`/`role` before the core ever saw them — so a user who wanted an
 * agent without describing it first was stuck at a disabled button.
 */
import { assertEquals } from "@std/assert";
import { stellaRoutes } from "./stella.ts";
import { jsonError } from "./util.ts";
import type { StellaApi } from "./stella.ts";

/** Only the create route matters here; it must receive what the client sent,
 * norm, untouched, so the core's rule is the only one in play. */
function fakeCore(received: { name: string; role: string }[]): StellaApi {
  return {
    createStellaAgent: (input: { name: string; role: string }) => {
      received.push(input);
      return {
        id: `a${received.length}`,
        name: input.name,
        role: input.role,
        identity: "",
        icon: "",
        createdAt: 0,
        updatedAt: 0,
      };
    },
  } as unknown as StellaApi;
}

async function create(
  body: unknown,
  received: { name: string; role: string }[],
) {
  const app = stellaRoutes(fakeCore(received));
  // The same error table the app mounts (app.ts's onError): a route mounted
  // on its own would otherwise answer Hono's default 500 for an AppError.
  app.onError((error, c) => jsonError(c, error));
  return await app.request("/stella/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("agent create: an empty body creates an agent", async () => {
  const received: { name: string; role: string }[] = [];
  const response = await create({}, received);
  assertEquals(response.status, 201);
  assertEquals(received, [{ name: "", role: "" }]);
});

Deno.test("agent create: a missing field reads as empty, not as an error", async () => {
  const received: { name: string; role: string }[] = [];
  assertEquals((await create({ name: "Notes" }, received)).status, 201);
  assertEquals((await create({ role: "Keeps notes" }, received)).status, 201);
  assertEquals(received, [
    { name: "Notes", role: "" },
    { name: "", role: "Keeps notes" },
  ]);
});

Deno.test("agent create: a non-string field is still a client bug", async () => {
  const received: { name: string; role: string }[] = [];
  const response = await create({ name: 42 }, received);
  assertEquals(response.status, 400);
  assertEquals(received, []);
});
