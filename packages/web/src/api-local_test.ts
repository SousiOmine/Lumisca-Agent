import { assert, assertEquals } from "@std/assert";

import type { UserProviderInput } from "./types.ts";

/** api-client.ts reads the page token once, when its module is evaluated
 * (`const token = globalThis.__LUMISCA_TOKEN__`), so the global has to be in
 * place before the module graph loads — hence the dynamic imports below. The
 * server embeds the global only when LUMISCA_TOKEN auth is on; the token set
 * here is what the header assertions expect on every request. */
globalThis.__LUMISCA_TOKEN__ = "test-token";
const { api } = await import("./api-local.ts");
const { onServerFailure } = await import("./api-client.ts");

/** Base URL the client's relative API paths are resolved against (the page
 * and the API share an origin, see api-client.ts). */
const BASE = "http://127.0.0.1:8000";

/** One request the client made, as these tests care about it. `path` keeps
 * the query string, which several calls build client-side. */
interface SentRequest {
  method: string;
  path: string;
  body: string | undefined;
  headers: Headers;
}

/** What the stubbed fetch answers. */
type Responder = () => Response | Promise<Response>;

/** The 200-with-an-empty-JSON-object answer every caller parses, so the
 * assertions below are about the request and not the response. */
const ok: Responder = () =>
  new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A JSON error answer, shaped like the server's (`{ error }` + status). */
function jsonError(status: number, error: string): Responder {
  return () =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** Replace `fetch` for the duration of `call` and report the single request
 * made plus the failure, if any. The stub is restored in a `finally`, so a
 * failing assertion cannot leak it into another test or file (the suite runs
 * with --parallel). */
async function intercept(
  call: () => Promise<unknown>,
  respond: Responder = ok,
): Promise<{ request: SentRequest; error?: Error }> {
  const original = globalThis.fetch;
  const sent: SentRequest[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target, BASE);
    sent.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(respond());
  };
  let error: Error | undefined;
  try {
    await call();
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error(String(cause));
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(sent.length, 1, "the call must reach the network exactly once");
  return { request: sent[0]!, error };
}

/** The request of a call that must succeed. */
async function record(
  call: () => Promise<unknown>,
  respond: Responder = ok,
): Promise<SentRequest> {
  const { request, error } = await intercept(call, respond);
  assertEquals(error, undefined, `the call must not fail: ${error?.message}`);
  return request;
}

/** One call under test: what it is (for failure messages), the HTTP method
 * and the path (pathname + query) the client must build, the call itself and
 * the exact body it must send (absent = no body at all). */
interface Case {
  name: string;
  method: string;
  path: string;
  call: () => Promise<unknown>;
  body?: string;
}

/** Run every case: the request the client builds is the contract with the
 * server routes, so the paths are pinned verbatim. */
async function assertCases(cases: Case[]): Promise<void> {
  for (const testCase of cases) {
    const sent = await record(testCase.call);
    assertEquals(
      sent.method,
      testCase.method,
      `the method of ${testCase.name}`,
    );
    assertEquals(sent.path, testCase.path, `the URL of ${testCase.name}`);
    assertEquals(sent.body, testCase.body, `the body of ${testCase.name}`);
    // Nothing may bypass the client: request() is what attaches the token.
    assertEquals(
      sent.headers.get("x-lumisca-token"),
      "test-token",
      `the token of ${testCase.name}`,
    );
  }
}

/** The body both create and update send verbatim (api-local.ts stringifies
 * the whole input, secret included — the server moves it to the credential
 * store and never echoes it back). */
const USER_PROVIDER_INPUT: UserProviderInput = {
  id: "local-llm",
  name: "Local LLM",
  baseUrl: "http://127.0.0.1:11434/v1",
  api: "openai-completions",
  models: [{ id: "llama3" }],
  apiKey: "sk-1",
};

const USER_PROVIDER_JSON = '{"id":"local-llm","name":"Local LLM",' +
  '"baseUrl":"http://127.0.0.1:11434/v1","api":"openai-completions",' +
  '"models":[{"id":"llama3"}],"apiKey":"sk-1"}';

const WORKSPACE_CASES: Case[] = [
  {
    name: "listWorkspaces",
    method: "GET",
    path: "/api/workspaces",
    call: () => api.listWorkspaces(),
  },
  {
    name: "createWorkspace",
    method: "POST",
    path: "/api/workspaces",
    call: () => api.createWorkspace("Demo", ["/home/u/proj"]),
    body: '{"name":"Demo","folders":["/home/u/proj"]}',
  },
  {
    name: "updateWorkspace",
    method: "PATCH",
    path: "/api/workspaces/ws-1",
    call: () => api.updateWorkspace("ws-1", { name: "Renamed" }),
    body: '{"name":"Renamed"}',
  },
  {
    name: "deleteWorkspace",
    method: "DELETE",
    path: "/api/workspaces/ws-1",
    call: () => api.deleteWorkspace("ws-1"),
  },
  {
    name: "workspaceFiles",
    method: "GET",
    path: "/api/workspaces/ws%201/files?query=a%2Fb%20c",
    call: () => api.workspaceFiles("ws 1", "a/b c"),
  },
  {
    name: "getSkills (chat)",
    method: "GET",
    path: "/api/skills",
    call: () => api.getSkills(),
  },
  {
    name: "getSkills (workspace)",
    method: "GET",
    path: "/api/skills?workspaceId=ws%201",
    call: () => api.getSkills("ws 1"),
  },
  {
    name: "fsRoots",
    method: "GET",
    path: "/api/fs/roots",
    call: () => api.fsRoots(),
  },
  {
    name: "fsBrowse",
    method: "GET",
    // A Windows path: both the drive colon and the separators are escaped.
    path: "/api/fs/browse?path=C%3A%5CUsers%5Cme",
    call: () => api.fsBrowse("C:\\Users\\me"),
  },
];

const SESSION_CASES: Case[] = [
  {
    name: "getDefaultModel",
    method: "GET",
    path: "/api/sessions/default-model",
    call: () => api.getDefaultModel(),
  },
  {
    name: "createSession",
    method: "POST",
    path: "/api/sessions",
    call: () => api.createSession({ workspaceId: "ws-1", name: "Hi" }),
    body: '{"workspaceId":"ws-1","name":"Hi"}',
  },
  {
    name: "listSessions",
    method: "GET",
    path: "/api/sessions",
    call: () => api.listSessions(),
  },
  {
    name: "getSession",
    method: "GET",
    path: "/api/sessions/s%201",
    call: () => api.getSession("s 1"),
  },
  {
    name: "closeSession",
    method: "POST",
    path: "/api/sessions/s1/close",
    call: () => api.closeSession("s1"),
  },
  {
    name: "getMessages",
    method: "GET",
    path: "/api/sessions/s1/messages",
    call: () => api.getMessages("s1"),
  },
  {
    name: "getTodo",
    method: "GET",
    path: "/api/sessions/s1/todo",
    call: () => api.getTodo("s1"),
  },
  {
    name: "getTasks",
    method: "GET",
    path: "/api/sessions/s1/tasks",
    call: () => api.getTasks("s1"),
  },
  {
    name: "getBackground",
    method: "GET",
    path: "/api/sessions/s1/background",
    call: () => api.getBackground("s1"),
  },
  {
    name: "getGoal",
    method: "GET",
    path: "/api/sessions/s1/goal",
    call: () => api.getGoal("s1"),
  },
  {
    name: "cancelGoal",
    method: "DELETE",
    path: "/api/sessions/s1/goal",
    call: () => api.cancelGoal("s1"),
  },
  {
    name: "prompt",
    method: "POST",
    path: "/api/sessions/s1/prompt",
    call: () => api.prompt("s1", "hello"),
    body: '{"text":"hello"}',
  },
  {
    // The composer's payload: data URLs lose their header (the API carries
    // bare base64), a bare base64 payload passes through, and mode metadata
    // rides along so the server builds a ModeMessage.
    name: "prompt with images and mode",
    method: "POST",
    path: "/api/sessions/s1/prompt",
    call: () =>
      api.prompt(
        "s1",
        "look at these",
        [
          { data: "data:image/png;base64,QUJD", mimeType: "image/png" },
          { data: "UkFX", mimeType: "image/jpeg" },
        ],
        {
          modeId: "review",
          optionId: "quick",
          modeLabel: "Review",
          shortText: "Review this",
        },
      ),
    body: '{"text":"look at these","images":[{"data":"QUJD",' +
      '"mimeType":"image/png"},{"data":"UkFX","mimeType":"image/jpeg"}],' +
      '"mode":{"modeId":"review","optionId":"quick","modeLabel":"Review",' +
      '"shortText":"Review this"}}',
  },
  {
    name: "abort",
    method: "POST",
    path: "/api/sessions/s1/abort",
    call: () => api.abort("s1"),
  },
  {
    name: "rewind",
    method: "POST",
    path: "/api/sessions/s1/rewind",
    call: () => api.rewind("s1", 1700000000000),
    body: '{"timestamp":1700000000000}',
  },
  {
    // No instructions, no body: the empty-string guard in api-local.ts keeps
    // a blank `/compact` from posting an empty instructions field.
    name: "compact",
    method: "POST",
    path: "/api/sessions/s1/compact",
    call: () => api.compact("s1"),
  },
  {
    name: "compact with instructions",
    method: "POST",
    path: "/api/sessions/s1/compact",
    call: () => api.compact("s1", "focus on tests"),
    body: '{"instructions":"focus on tests"}',
  },
  {
    name: "answer",
    method: "POST",
    path: "/api/sessions/s1/answer",
    call: () => api.answer("s1", "call-1", [{ id: "q1", values: ["yes"] }]),
    body: '{"toolCallId":"call-1","answers":[{"id":"q1","values":["yes"]}]}',
  },
  {
    name: "updateSessionModel",
    method: "POST",
    path: "/api/sessions/s1/model",
    call: () => api.updateSessionModel("s1", "anthropic", "claude-sonnet-4"),
    body: '{"provider":"anthropic","modelId":"claude-sonnet-4"}',
  },
];

const PROVIDER_CASES: Case[] = [
  {
    name: "listProviders",
    method: "GET",
    path: "/api/providers",
    call: () => api.listProviders(),
  },
  {
    name: "listModels",
    method: "GET",
    path: "/api/providers/anthropic/models",
    call: () => api.listModels("anthropic"),
  },
  {
    name: "catalogStatus",
    method: "GET",
    path: "/api/providers/catalog",
    call: () => api.catalogStatus(),
  },
  {
    name: "refreshCatalog",
    method: "POST",
    path: "/api/providers/catalog/refresh",
    call: () => api.refreshCatalog(),
  },
  {
    name: "setModelEnabled",
    method: "PUT",
    path: "/api/providers/anthropic/models/claude-3-5",
    call: () => api.setModelEnabled("anthropic", "claude-3-5", true),
    body: '{"enabled":true}',
  },
  {
    // Model ids of OpenAI-compatible providers contain "/" (openrouter's
    // "anthropic/claude-sonnet-4"), so the segment must be escaped to stay
    // one segment.
    name: "setModelThinkingLevel (slash in the model id)",
    method: "PUT",
    path: "/api/providers/anthropic/models/claude%2Fsonnet-4/thinking-level",
    call: () =>
      api.setModelThinkingLevel("anthropic", "claude/sonnet-4", "high"),
    body: '{"level":"high"}',
  },
  {
    name: "providerAuth",
    method: "GET",
    path: "/api/providers/anthropic/auth",
    call: () => api.providerAuth("anthropic"),
  },
  {
    name: "setApiKey",
    method: "POST",
    path: "/api/providers/anthropic/api-key",
    call: () => api.setApiKey("anthropic", "sk-1"),
    body: '{"key":"sk-1"}',
  },
  {
    name: "providerLogin",
    method: "POST",
    path: "/api/providers/anthropic/login",
    call: () => api.providerLogin("anthropic"),
  },
  {
    name: "providerLoginPoll",
    method: "GET",
    path: "/api/providers/anthropic/login/sess-1",
    call: () => api.providerLoginPoll("anthropic", "sess-1"),
  },
  {
    name: "providerLoginRespond",
    method: "POST",
    path: "/api/providers/anthropic/login/sess-1/respond",
    call: () => api.providerLoginRespond("anthropic", "sess-1", "p1", "code"),
    body: '{"promptId":"p1","value":"code"}',
  },
  {
    name: "providerLoginCancel",
    method: "POST",
    path: "/api/providers/anthropic/login/sess-1/cancel",
    call: () => api.providerLoginCancel("anthropic", "sess-1"),
  },
  {
    name: "providerLogout",
    method: "POST",
    path: "/api/providers/anthropic/logout",
    call: () => api.providerLogout("anthropic"),
  },
  {
    name: "listUserProviders",
    method: "GET",
    path: "/api/providers/user",
    call: () => api.listUserProviders(),
  },
  {
    name: "createUserProvider",
    method: "POST",
    path: "/api/providers/user",
    call: () => api.createUserProvider(USER_PROVIDER_INPUT),
    body: USER_PROVIDER_JSON,
  },
  {
    name: "updateUserProvider",
    method: "PUT",
    path: "/api/providers/user/local-llm",
    call: () => api.updateUserProvider("local-llm", USER_PROVIDER_INPUT),
    body: USER_PROVIDER_JSON,
  },
  {
    name: "deleteUserProvider",
    method: "DELETE",
    path: "/api/providers/user/local-llm",
    call: () => api.deleteUserProvider("local-llm"),
  },
];

const SETTINGS_CASES: Case[] = [
  {
    name: "getMcpConfig",
    method: "GET",
    path: "/api/mcp",
    call: () => api.getMcpConfig(),
  },
  {
    // The server reads this route's body as raw text (routes/mcp.ts uses
    // c.req.text()), so the config text must not be wrapped in JSON.
    name: "putMcpConfig (raw text body)",
    method: "PUT",
    path: "/api/mcp",
    call: () => api.putMcpConfig('{"mcpServers":{}}'),
    body: '{"mcpServers":{}}',
  },
  {
    name: "getSettings",
    method: "GET",
    path: "/api/settings",
    call: () => api.getSettings(),
  },
  {
    name: "setSetting",
    method: "PUT",
    path: "/api/settings/locale",
    call: () => api.setSetting("locale", "ja"),
    body: '{"value":"ja"}',
  },
  {
    name: "getCommandSafety",
    method: "GET",
    path: "/api/settings/command-safety",
    call: () => api.getCommandSafety(),
  },
  {
    name: "deleteCommandApproval",
    method: "DELETE",
    path: "/api/settings/command-safety/approvals",
    call: () => api.deleteCommandApproval("h1"),
    body: '{"hash":"h1"}',
  },
  {
    name: "clearCommandApprovals",
    method: "DELETE",
    path: "/api/settings/command-safety/approvals/all",
    call: () => api.clearCommandApprovals(),
  },
  {
    name: "getPersonalization",
    method: "GET",
    path: "/api/personalize",
    call: () => api.getPersonalization(),
  },
  {
    name: "putPersonalization",
    method: "PUT",
    path: "/api/personalize",
    call: () => api.putPersonalization("# AGENTS.md"),
    body: '{"content":"# AGENTS.md"}',
  },
  {
    name: "getSavedPrompts",
    method: "GET",
    path: "/api/settings/saved-prompts",
    call: () => api.getSavedPrompts(),
  },
  {
    name: "createSavedPrompt",
    method: "POST",
    path: "/api/settings/saved-prompts",
    call: () =>
      api.createSavedPrompt({
        id: "translate",
        label: "Translate",
        prompt: "Translate: ",
      }),
    body: '{"id":"translate","label":"Translate","prompt":"Translate: "}',
  },
  {
    name: "updateSavedPrompt (escaped id)",
    method: "PUT",
    path: "/api/settings/saved-prompts/p%201",
    call: () => api.updateSavedPrompt("p 1", { label: "L" }),
    body: '{"label":"L"}',
  },
  {
    name: "deleteSavedPrompt (escaped id)",
    method: "DELETE",
    path: "/api/settings/saved-prompts/p%201",
    call: () => api.deleteSavedPrompt("p 1"),
  },
  {
    name: "getConnections",
    method: "GET",
    path: "/api/connections",
    call: () => api.getConnections(),
  },
  {
    name: "putConnections",
    method: "PUT",
    path: "/api/connections",
    call: () =>
      api.putConnections([
        { id: "peer-1", name: "Peer", url: "http://peer:8000", token: "t" },
      ]),
    body: '{"connections":[{"id":"peer-1","name":"Peer",' +
      '"url":"http://peer:8000","token":"t"}]}',
  },
];

Deno.test("api-local: workspace, skill and filesystem calls", () =>
  assertCases(WORKSPACE_CASES));

Deno.test("api-local: session calls", () => assertCases(SESSION_CASES));

Deno.test("api-local: provider and model calls", () =>
  assertCases(PROVIDER_CASES));

Deno.test("api-local: settings, MCP, personalization and connections", () =>
  assertCases(SETTINGS_CASES));

Deno.test("api-local: the page token rides on every request", async () => {
  const sent = await record(() => api.listSessions());
  assertEquals(sent.headers.get("x-lumisca-token"), "test-token");
  assertEquals(sent.headers.get("content-type"), "application/json");
});

Deno.test("api-local: an HTTP error becomes an Error carrying the server's message", async () => {
  // Errors are answered as { error: "..." } with a 4xx/5xx status, so the
  // client must surface that text and not a generic status message — the UI
  // shows the string as-is.
  const { error } = await intercept(
    () => api.listWorkspaces(),
    jsonError(500, "Workspace store is locked"),
  );
  assert(error instanceof Error, "the call must fail");
  assertEquals(error.message, "Workspace store is locked");
});

Deno.test("api-local: a non-JSON error body falls back to the status", async () => {
  // A proxy or a half-dead server answers HTML; res.json() then fails and
  // the rejection must still name the status instead of a parse error.
  const { error } = await intercept(
    () => api.listWorkspaces(),
    () => new Response("<html>down</html>", { status: 503 }),
  );
  assert(error instanceof Error, "the call must fail");
  assertEquals(error.message, "Request failed: 503");
});

Deno.test("api-local: a network failure notifies the health monitor, an HTTP error does not", async () => {
  // The desktop shell registers a listener (hooks/useServerHealth.ts) to
  // classify a dead server; only a fetch-level rejection is an outage, an
  // answered 500 is not.
  const failures: string[] = [];
  const unsubscribe = onServerFailure(() => failures.push("network"));
  try {
    const offline = await intercept(
      () => api.listWorkspaces(),
      () => Promise.reject(new TypeError("Failed to fetch")),
    );
    assert(offline.error instanceof TypeError, "the fetch error must surface");
    assertEquals(offline.error.message, "Failed to fetch");
    assertEquals(failures.length, 1, "a fetch rejection is an outage");

    const answered = await intercept(
      () => api.listWorkspaces(),
      jsonError(500, "boom"),
    );
    assertEquals(answered.error?.message, "boom");
    assertEquals(failures.length, 1, "an answered HTTP error is not an outage");
  } finally {
    unsubscribe();
  }
});
