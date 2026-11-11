import {
  DEFAULT_MODEL_KEY,
  serializeModelPreference,
} from "@lumisca/core/shared";
import { assertEquals, assertRejects } from "@std/assert";
import { rememberDefaultModel } from "./defaultModel.ts";
import { settingsStore } from "./settingsStore.ts";

/** One request the client sent, as far as these tests care: the route wraps
 * the settings value in `{ value }`, so only that value is kept. */
interface Sent {
  method: string;
  path: string;
  value: string | undefined;
}

/** Run `call` with `fetch` replaced by a recorder answering `respond`, and
 * report every request it sent, in order. */
async function withFetch(
  respond: (sent: Sent) => Response,
  call: () => Promise<void>,
): Promise<Sent[]> {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target, "http://127.0.0.1:8000");
    const body = typeof init?.body === "string" ? init.body : undefined;
    const request: Sent = {
      method: init?.method ?? "GET",
      path: url.pathname,
      value:
        body === undefined
          ? undefined
          : (JSON.parse(body) as { value: string }).value,
    };
    sent.push(request);
    return Promise.resolve(respond(request));
  };
  try {
    await call();
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

const ok = () => new Response("{}", { status: 200 });

/** An answer to `GET /api/settings`: one key per entry of `table`. */
const table = (values: Record<string, string>) => () =>
  new Response(JSON.stringify(values), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const preference = (provider: string, modelId: string) =>
  serializeModelPreference({ provider, modelId });

// First on purpose: the shared store starts unread, which is the state the
// new-session screen is in when it is the first screen a page shows.
Deno.test("rememberDefaultModel reads the settings before its first write", async () => {
  const sent = await withFetch(
    (request) => (request.method === "GET" ? table({ theme: "dark" })() : ok()),
    () => rememberDefaultModel("anthropic", "claude-sonnet-4-5"),
  );
  assertEquals(
    sent.map((r) => `${r.method} ${r.path}`),
    ["GET /api/settings", "PUT /api/settings/model_default"],
  );
  // The write marks the table as read, so every panel reading the store would
  // show the values it never loaded: the read comes first, and the other
  // settings survive it.
  assertEquals(settingsStore.value("theme"), "dark");
  assertEquals(
    settingsStore.value(DEFAULT_MODEL_KEY),
    preference("anthropic", "claude-sonnet-4-5"),
  );
});

Deno.test("rememberDefaultModel writes the pick to the default model key", async () => {
  settingsStore.reset();
  const sent = await withFetch(ok, () =>
    rememberDefaultModel("anthropic", "claude-sonnet-4-5"),
  );
  // The path is the contract: the session resolver reads this same key
  // first, which is what makes the pick survive a reload or a tab switch.
  assertEquals(sent, [
    {
      method: "PUT",
      path: "/api/settings/model_default",
      value: preference("anthropic", "claude-sonnet-4-5"),
    },
  ]);
});

Deno.test("rememberDefaultModel writes nothing when it already is the default", async () => {
  settingsStore.reset();
  await withFetch(ok, () => rememberDefaultModel("openai", "gpt-5"));
  const sent = await withFetch(ok, () =>
    rememberDefaultModel("openai", "gpt-5"),
  );
  assertEquals(sent, [], "a second pick of the same model is not a request");
});

Deno.test("rememberDefaultModel reports a failed write instead of keeping it", async () => {
  settingsStore.reset();
  await assertRejects(() =>
    withFetch(
      () => new Response("{}", { status: 500 }),
      () => rememberDefaultModel("openai", "gpt-5"),
    ),
  );
  // The stored value is what the next session would run on, so a failed
  // write must not leave the store claiming the model was remembered.
  assertEquals(settingsStore.value(DEFAULT_MODEL_KEY), undefined);
});
