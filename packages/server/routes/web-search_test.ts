import { assert, assertEquals } from "@std/assert";
import type {
  WebSearchSettingsView,
  WebSearchTestView,
} from "@lumisca/core/shared";
import { webSearchRoutes } from "./web-search.ts";
import { jsonError } from "./util.ts";

/** A stand-in for the core that records what the routes forwarded and
 * answers with a fixed view. */
class FakeWebSearchApi {
  calls: { method: string; args: unknown[] }[] = [];
  view: WebSearchSettingsView = {
    defaultId: null,
    providers: [],
    available: [{ id: "exa", name: "Exa", supportsFetch: true }],
  };
  testResult: WebSearchTestView = { ok: true, detail: null, results: 1 };

  getWebSearchSettings(): WebSearchSettingsView {
    return this.view;
  }
  addWebSearchProvider(input: { id: string; apiKey: string }) {
    this.calls.push({ method: "add", args: [input] });
    return this.view;
  }
  updateWebSearchProvider(id: string, input: { apiKey: string }) {
    this.calls.push({ method: "update", args: [id, input] });
    return this.view;
  }
  removeWebSearchProvider(id: string) {
    this.calls.push({ method: "remove", args: [id] });
    return this.view;
  }
  setDefaultWebSearchProvider(id: string | null) {
    this.calls.push({ method: "setDefault", args: [id] });
    return this.view;
  }
  testWebSearchProvider(input: { id: string; apiKey: string | null }) {
    this.calls.push({ method: "test", args: [input] });
    return Promise.resolve(this.testResult);
  }
}

function makeApp(fake: FakeWebSearchApi) {
  const app = webSearchRoutes(fake);
  app.onError((error, c) => jsonError(c, error));
  return app;
}

Deno.test("/web-search serves the setting without keys", async () => {
  const fake = new FakeWebSearchApi();
  const response = await makeApp(fake).request("/web-search");
  assertEquals(response.status, 200);
  const view = await response.json() as WebSearchSettingsView;
  assertEquals(view.defaultId, null);
  // The view carries whether a key is stored, never the key.
  assert(!("apiKey" in view));
});

Deno.test("/web-search/providers adds with the id and key it was given", async () => {
  const fake = new FakeWebSearchApi();
  const response = await makeApp(fake).request("/web-search/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "exa", apiKey: "k" }),
  });
  assertEquals(response.status, 201);
  assertEquals(fake.calls, [{
    method: "add",
    args: [{ id: "exa", apiKey: "k" }],
  }]);
});

Deno.test("/web-search/providers rejects a missing or empty field", async () => {
  const app = makeApp(new FakeWebSearchApi());

  const noKey = await app.request("/web-search/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "exa" }),
  });
  assertEquals(noKey.status, 400);

  const emptyId = await app.request("/web-search/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "", apiKey: "k" }),
  });
  assertEquals(emptyId.status, 400);

  const badJson = await app.request("/web-search/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assertEquals(badJson.status, 400);
});

Deno.test("/web-search/providers/:id updates with an empty key when omitted", async () => {
  const fake = new FakeWebSearchApi();
  const app = makeApp(fake);

  const response = await app.request("/web-search/providers/exa", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(response.status, 200);
  // An omitted key means "keep the stored one": the route says so with an
  // empty string rather than inventing a key or refusing the request.
  assertEquals(fake.calls, [
    { method: "update", args: ["exa", { apiKey: "" }] },
  ]);

  const wrong = await app.request("/web-search/providers/exa", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: 7 }),
  });
  assertEquals(wrong.status, 400);
});

Deno.test("/web-search default accepts a string or null", async () => {
  const fake = new FakeWebSearchApi();
  const app = makeApp(fake);

  await app.request("/web-search/default", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "exa" }),
  });
  await app.request("/web-search/default", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: null }),
  });
  assertEquals(fake.calls, [
    { method: "setDefault", args: ["exa"] },
    { method: "setDefault", args: [null] },
  ]);

  const wrong = await app.request("/web-search/default", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 5 }),
  });
  assertEquals(wrong.status, 400);
});

Deno.test("/web-search/test reports a failed check as a result, not an error", async () => {
  const fake = new FakeWebSearchApi();
  fake.testResult = {
    ok: false,
    detail: "API キーが受け付けられませんでした",
    results: 0,
  };
  const response = await makeApp(fake).request("/web-search/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "exa", apiKey: "k" }),
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), fake.testResult);
});

Deno.test("/web-search/test forwards a null key (the stored one is used)", async () => {
  const fake = new FakeWebSearchApi();
  await makeApp(fake).request("/web-search/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "exa", apiKey: null }),
  });
  assertEquals(fake.calls, [
    { method: "test", args: [{ id: "exa", apiKey: null }] },
  ]);
});

Deno.test("/web-search/providers/:id deletes", async () => {
  const fake = new FakeWebSearchApi();
  const response = await makeApp(fake).request("/web-search/providers/exa", {
    method: "DELETE",
  });
  assertEquals(response.status, 200);
  assertEquals(fake.calls, [{ method: "remove", args: ["exa"] }]);
});
