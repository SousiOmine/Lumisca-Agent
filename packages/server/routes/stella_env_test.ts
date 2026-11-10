import { stellaApiStub } from "./test-stubs.ts";
/**
 * The two answers to the `vm_env` dialog: the value, and a refusal.
 *
 * The shape this pins: the value travels from the browser into the machine
 * and nowhere else. The route hands it to the core with the name the agent
 * asked for (the core takes that from the pending request), the response
 * says only `{ ok: true }`, and nothing about the value is echoed, logged or
 * recorded by the route.
 */
import { assertEquals } from "@std/assert";
import { CoreError } from "@lumisca/core";
import type { SessionInfo, StellaAgent } from "@lumisca/core";
import { stellaRoutes } from "./stella.ts";
import { jsonError } from "./util.ts";
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

const SESSION = {
  id: "s1",
  workspaceId: "w1",
  name: "Aide",
  modelProvider: "faux",
  modelId: "faux-1",
  stella: true,
  agentId: "a1",
  createdAt: 0,
  updatedAt: 0,
} as SessionInfo;

/** What the routes asked the core to do. */
interface Received {
  provided: { sessionId: string; value: unknown; toolCallId?: string }[];
  declined: { sessionId: string; toolCallId?: string }[];
}

function fakeCore(
  received: Received,
  options: { failWith?: CoreError } = {},
): StellaApi {
  const agentOf = (id: string) => id === AGENT.id ? AGENT : undefined;
  const sessionOf = (id: string) => id === AGENT.id ? SESSION : undefined;
  return stellaApiStub({
    getStellaAgent: agentOf,
    findStellaSession: sessionOf,
    ensureStellaAgent: () => Promise.resolve(AGENT),
    createStellaAgent: () => Promise.resolve(AGENT),
    provideStellaEnv: (
      sessionId: string,
      value: unknown,
      toolCallId?: string,
    ) => {
      if (options.failWith !== undefined) {
        return Promise.reject(options.failWith);
      }
      received.provided.push({ sessionId, value, toolCallId });
      return Promise.resolve();
    },
    declineStellaEnv: (sessionId: string, toolCallId?: string) => {
      received.declined.push({ sessionId, toolCallId });
    },
  });
}

function setup(options: { failWith?: CoreError } = {}) {
  const received: Received = { provided: [], declined: [] };
  const app = stellaRoutes(fakeCore(received, options));
  // The same error table the app mounts (app.ts's onError).
  app.onError((error, c) => jsonError(c, error));
  return { app, received };
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

Deno.test("stella env: the value reaches the core and is not echoed", async () => {
  const { app, received } = setup();
  const response = await app.request(
    "/stella/conversations/a1/env",
    post({ value: "sk-abc", toolCallId: "t1" }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  // The name is not part of the body: the core takes it from the pending
  // request, so a dialog can only fill the question it was opened for.
  assertEquals(received.provided, [{
    sessionId: "s1",
    value: "sk-abc",
    toolCallId: "t1",
  }]);
});

Deno.test("stella env: a refusal lets the run continue", async () => {
  const { app, received } = setup();
  const response = await app.request(
    "/stella/conversations/a1/env/decline",
    post({ toolCallId: "t1" }),
  );
  assertEquals(response.status, 200);
  assertEquals(received.declined, [{ sessionId: "s1", toolCallId: "t1" }]);
});

Deno.test("stella env: a dialog nobody waits on answers 404", async () => {
  // The deadline passed (or the run was stopped) while the dialog was open:
  // the answer has nowhere to go, and the client must say so rather than
  // close as if it had been saved.
  const { app } = setup({
    failWith: new CoreError(
      "No environment variable is waiting for the user",
      "not_found",
    ),
  });
  const response = await app.request(
    "/stella/conversations/a1/env",
    post({ value: "sk-abc", toolCallId: "t1" }),
  );
  assertEquals(response.status, 404);
});

Deno.test("stella env: the route hands the value over unread", async () => {
  // Validation (empty, too long, NUL) lives in one place — the store the core
  // writes with — so this pins that the route does not trim or coerce it on
  // the way; 42 reaches the core as 42 and is refused there.
  const { app, received } = setup();
  await app.request(
    "/stella/conversations/a1/env",
    post({ value: 42, toolCallId: "t1" }),
  );
  assertEquals(received.provided[0]?.value, 42);
});

Deno.test("stella env: a toolCallId that is not a string answers 400", async () => {
  const { app } = setup();
  const response = await app.request(
    "/stella/conversations/a1/env",
    post({ value: "sk-abc", toolCallId: 7 }),
  );
  assertEquals(response.status, 400);
});

Deno.test("stella env: an unknown agent answers 404", async () => {
  const { app } = setup();
  const response = await app.request(
    "/stella/conversations/nope/env",
    post({ value: "sk-abc" }),
  );
  assertEquals(response.status, 404);
});
