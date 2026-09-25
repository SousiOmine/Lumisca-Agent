import { assertEquals } from "@std/assert";
import { serverUpdateApi } from "./shell.ts";

/** Base URL the client's relative API paths are resolved against (the page
 * and the API share an origin, see api-client.ts). */
const BASE = "http://127.0.0.1:8000";

/** One request the client made, as this test cares about it. */
interface SentRequest {
  method: string;
  path: string;
  body: string | undefined;
}

/** Run `call` with `fetch` replaced by a recorder and report what it sent.
 * The stub answers 200 with an empty JSON object — the shape every caller
 * parses — so the assertions are about the request, not the response. */
async function record(call: () => Promise<unknown>): Promise<SentRequest> {
  const original = globalThis.fetch;
  const sent: SentRequest[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    sent.push({
      method: init?.method ?? "GET",
      path: new URL(target, BASE).pathname,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await call();
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(
    sent.length,
    1,
    "the action must reach the network exactly once",
  );
  return sent[0]!;
}

/** One action under test: its path segment, the client call, and the body
 * that call has to send (undefined = no body). */
type ActionCase = [
  action: string,
  call: () => Promise<unknown>,
  body: string | undefined,
];

/** The standalone server answers one read and posts everything else (see
 * packages/server/routes/update.ts). A GET on an action path is answered
 * with 404 "Not found", so a client that sends one — as this one did for
 * the four body-less actions — can never drive the updater: pressing any
 * update button in a browser would do nothing at all. The pair is pinned
 * here so a refactor cannot quietly infer the method again. */
Deno.test("serverUpdateApi: status is a GET, every action is a POST", async () => {
  const status = await record(() => serverUpdateApi.status());
  assertEquals(status.method, "GET");
  assertEquals(status.path, "/api/update/status");
  assertEquals(status.body, undefined);

  const actions: ActionCase[] = [
    ["check", () => serverUpdateApi.check(), undefined],
    ["download", () => serverUpdateApi.download(), undefined],
    ["install", () => serverUpdateApi.install(), undefined],
    ["restart", () => serverUpdateApi.restart(), undefined],
    ["set-auto", () => serverUpdateApi.setAuto(true), '{"enabled":true}'],
    [
      "set-auto-restart",
      () => serverUpdateApi.setAutoRestart(false),
      '{"enabled":false}',
    ],
  ];

  for (const [action, call, body] of actions) {
    const request = await record(call);
    assertEquals(
      request.method,
      "POST",
      `${action} mutates the installation and must be POSTed`,
    );
    assertEquals(request.path, `/api/update/${action}`);
    assertEquals(request.body, body, `the body of ${action}`);
  }
});
