import { assertEquals } from "@std/assert";
import { splitTabKey, tabKey } from "./tabs.ts";

/** api-client.ts captures the page token once, when its module is evaluated
 * (`const token = globalThis.__LUMISCA_TOKEN__`), so the global must be in
 * place before that — hence the dynamic import of api-routing.ts below.
 * connectEvents() is the one call that has to put the token in the URL
 * (browsers cannot set WS headers), so a token carrying a "/" and a "+"
 * pins that encoding too. */
globalThis.__LUMISCA_TOKEN__ = "tok/en+1";
const { connectEvents, modelApi, sessionApi, workspaceApi } = await import(
  "./api-routing.ts"
);

/** Base URL the client's relative API paths are resolved against (the page
 * and the API share an origin, see api-client.ts). */
const BASE = "http://127.0.0.1:8000";

/** One request the client made, as these tests care about it. `path` keeps
 * the query string, which several calls build client-side. */
interface SentRequest {
  method: string;
  path: string;
  body: string | undefined;
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

/** Run `call` with `fetch` replaced by a recorder and report the single
 * request it sent plus the failure, if any. The stub is restored in a
 * `finally`, so a failing assertion cannot leak it into another test or
 * file (the suite runs with --parallel). */
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
  // One call, one request: a fallback (local after a failed peer, or a
  // retried call) would show up here.
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

/** Pin one request: its HTTP method, its path (pathname + query) and its
 * body (undefined = no body at all). */
function assertRequest(
  sent: SentRequest,
  method: string,
  path: string,
  body: string | undefined = undefined,
): void {
  assertEquals(sent.method, method, `the method of ${path}`);
  assertEquals(sent.path, path, `the URL of ${path}`);
  assertEquals(sent.body, body, `the body of ${path}`);
}

/** One call under test: the HTTP method, the path below `/api`, the call
 * itself and the body it must send. The routing tests run each table through
 * every form below, so a mis-wired method is caught as a URL that drives the
 * wrong machine's session — not merely as a failing request. */
type RoutedCase<A> = [
  method: string,
  path: string,
  call: (api: A) => Promise<unknown>,
  body: string | undefined,
];

/** One form of the API: the argument its factory takes and the URL prefix
 * that argument must produce. For `sessionApi` the argument is a tab key
 * (composite), for workspaceApi/modelApi it is a peer id ("" = this server).
 */
interface Form {
  key: string;
  prefix: string;
}

const THIS_SERVER: Form = { key: "", prefix: "/api" };
const PEER_1: Form = { key: "peer-1", prefix: "/api/fed/peer-1" };

/** The same session on either machine: the tab key is the session id alone
 * locally, and `<peerId>:<sessionId>` on a peer (tabs.ts). */
const SESSION_THIS_SERVER: Form = { key: "sess-1", prefix: "/api" };
const SESSION_ON_PEER_1: Form = {
  key: "peer-1:sess-1",
  prefix: "/api/fed/peer-1",
};

/** Run every case through every form and pin the resulting request. */
async function assertRouted<A>(
  cases: Array<RoutedCase<A>>,
  makeApi: (key: string) => A,
  forms: Form[],
): Promise<void> {
  for (const [method, path, call, body] of cases) {
    for (const form of forms) {
      assertRequest(
        await record(() => call(makeApi(form.key))),
        method,
        `${form.prefix}${path}`,
        body,
      );
    }
  }
}

type SessionApi = ReturnType<typeof sessionApi>;
type WorkspaceApi = ReturnType<typeof workspaceApi>;
type ModelApi = ReturnType<typeof modelApi>;

const SESSION_CASES: Array<RoutedCase<SessionApi>> = [
  ["GET", "/sessions/sess-1", (s) => s.getSession(), undefined],
  ["GET", "/sessions/sess-1/messages", (s) => s.getMessages(), undefined],
  ["GET", "/sessions/sess-1/todo", (s) => s.getTodo(), undefined],
  ["GET", "/sessions/sess-1/tasks", (s) => s.getTasks(), undefined],
  ["GET", "/sessions/sess-1/background", (s) => s.getBackground(), undefined],
  ["GET", "/sessions/sess-1/goal", (s) => s.getGoal(), undefined],
  ["DELETE", "/sessions/sess-1/goal", (s) => s.cancelGoal(), undefined],
  ["POST", "/sessions/sess-1/close", (s) => s.close(), undefined],
  [
    "POST",
    "/sessions/sess-1/prompt",
    (s) => s.prompt("hello"),
    '{"text":"hello"}',
  ],
  ["POST", "/sessions/sess-1/abort", (s) => s.abort(), undefined],
  [
    "POST",
    "/sessions/sess-1/rewind",
    (s) => s.rewind(1700000000000),
    '{"timestamp":1700000000000}',
  ],
  [
    "POST",
    "/sessions/sess-1/compact",
    (s) => s.compact("focus on tests"),
    '{"instructions":"focus on tests"}',
  ],
  [
    "POST",
    "/sessions/sess-1/answer",
    (s) => s.answer("call-1", [{ id: "q1", values: ["yes"] }]),
    '{"toolCallId":"call-1","answers":[{"id":"q1","values":["yes"]}]}',
  ],
  [
    "POST",
    "/sessions/sess-1/model",
    (s) => s.updateModel("anthropic", "claude-sonnet-4"),
    '{"provider":"anthropic","modelId":"claude-sonnet-4"}',
  ],
];

const WORKSPACE_CASES: Array<RoutedCase<WorkspaceApi>> = [
  [
    "POST",
    "/workspaces",
    (w) => w.create("Demo", ["/home/u/proj"]),
    '{"name":"Demo","folders":["/home/u/proj"]}',
  ],
  [
    "PATCH",
    "/workspaces/ws-1",
    (w) => w.update("ws-1", { name: "Renamed" }),
    '{"name":"Renamed"}',
  ],
  ["DELETE", "/workspaces/ws-1", (w) => w.delete("ws-1"), undefined],
  ["GET", "/fs/roots", (w) => w.fsRoots(), undefined],
  [
    "GET",
    "/fs/browse?path=C%3A%5CUsers%5Cme",
    (w) => w.fsBrowse("C:\\Users\\me"),
    undefined,
  ],
];

const MODEL_CASES: Array<RoutedCase<ModelApi>> = [
  ["GET", "/providers", (m) => m.listProviders(), undefined],
  [
    "GET",
    "/providers/anthropic/models",
    (m) => m.listModels("anthropic"),
    undefined,
  ],
  [
    "PUT",
    "/providers/anthropic/models/claude%2Fsonnet-4/thinking-level",
    (m) => m.setThinkingLevel("anthropic", "claude/sonnet-4", "high"),
    '{"level":"high"}',
  ],
];

Deno.test("api-routing: a bare tab key is this server and never the fed proxy", async () => {
  const local = sessionApi("sess-1");
  assertEquals(local.peerId, "");
  assertEquals(local.sessionId, "sess-1");
  await assertRouted(SESSION_CASES, sessionApi, [SESSION_THIS_SERVER]);
});

Deno.test("api-routing: a peer-prefixed tab key sends every session call to the peer", async () => {
  const remote = sessionApi("peer-1:sess-1");
  assertEquals(remote.peerId, "peer-1");
  assertEquals(remote.sessionId, "sess-1");
  await assertRouted(SESSION_CASES, sessionApi, [SESSION_ON_PEER_1]);
});

Deno.test("api-routing: the same session id addresses either machine", async () => {
  // Both forms in one run: the id is shared, only the prefix differs, so a
  // routing regression in either direction fails here.
  await assertRouted(SESSION_CASES, sessionApi, [
    SESSION_THIS_SERVER,
    SESSION_ON_PEER_1,
  ]);
});

Deno.test("api-routing: workspace calls follow the peer that owns the workspace", async () => {
  await assertRouted(WORKSPACE_CASES, workspaceApi, [THIS_SERVER, PEER_1]);
});

Deno.test("api-routing: the model picker follows the machine running the agent", async () => {
  await assertRouted(MODEL_CASES, modelApi, [THIS_SERVER, PEER_1]);
});

Deno.test("api-routing: the model catalog stays on this server for every peer", async () => {
  // api-routing.ts documents the catalog endpoints as intentionally
  // local-only: the settings UI that drives them has no peer switcher.
  assertRequest(
    await record(() => modelApi("").catalogStatus()),
    "GET",
    "/api/providers/catalog",
  );
  assertRequest(
    await record(() => modelApi("peer-1").catalogStatus()),
    "GET",
    "/api/providers/catalog",
  );
  assertRequest(
    await record(() => modelApi("peer-1").refreshCatalog()),
    "POST",
    "/api/providers/catalog/refresh",
  );
});

Deno.test("api-routing: a disconnected peer fails loudly instead of falling back", async () => {
  // A peer that is switched off (or no longer in the registry) makes the
  // hub's fed proxy answer 404 with requirePeer's message
  // (server/routes/federation.ts). Routing must surface that failure: the
  // call must not be retried against a local session that merely shares the
  // id — that would run the agent on the wrong machine.
  const { request, error } = await intercept(
    () => sessionApi("peer-gone:sess-1").getMessages(),
    jsonError(404, "Peer not found: peer-gone"),
  );
  assertRequest(request, "GET", "/api/fed/peer-gone/sessions/sess-1/messages");
  assertEquals(error?.message, "Peer not found: peer-gone");
});

Deno.test("api-routing: a colon in the session id survives the whole path", async () => {
  // splitTabKey cuts at the *first* colon, so everything after the peer
  // prefix belongs to the session id, and sessionPath percent-encodes it
  // instead of letting it split a path segment.
  const session = sessionApi("peer-1:sess:2");
  assertEquals(session.peerId, "peer-1");
  assertEquals(session.sessionId, "sess:2");
  assertRequest(
    await record(() => session.getMessages()),
    "GET",
    "/api/fed/peer-1/sessions/sess%3A2/messages",
  );
});

Deno.test("api-routing: a colon in a bare session id reads as a peer prefix (pinned)", async () => {
  // Documented consequence of the key format: PREFIX:SESSION is ambiguous,
  // so a colon in a session id makes the "local" tab look federated. Server
  // session ids come from crypto.randomUUID() (core/session/repo.ts), so a
  // real one has no colon; pinned so that a change is deliberate.
  const session = sessionApi("sess:2");
  assertEquals(session.peerId, "sess");
  assertEquals(session.sessionId, "2");
  assertRequest(
    await record(() => session.getMessages()),
    "GET",
    "/api/fed/sess/sessions/2/messages",
  );
});

Deno.test("api-routing: a peer id containing ':' stays one peer", async () => {
  // Connection ids are only checked for being non-empty
  // (server/routes/connections.ts) while the UI generates them with
  // crypto.randomUUID(), so a hand-written registry entry may carry the key
  // separator. tabKey escapes it: splitting naively would address peer
  // "peer" for session "1:sess-1" — someone else's session.
  const key = tabKey("peer:1", "sess-1");
  assertEquals(splitTabKey(key), { peerId: "peer:1", sessionId: "sess-1" });
  const session = sessionApi(key);
  assertEquals(session.peerId, "peer:1");
  assertEquals(session.sessionId, "sess-1");
  assertRequest(
    await record(() => session.getMessages()),
    "GET",
    "/api/fed/peer%3A1/sessions/sess-1/messages",
  );
});

Deno.test("api-routing: tabKey/splitTabKey are the two halves sessionApi reads", () => {
  // The complement of the tests above: the key builders themselves.
  assertEquals(tabKey("", "sess-1"), "sess-1");
  assertEquals(splitTabKey("sess-1"), { peerId: "", sessionId: "sess-1" });
  assertEquals(tabKey("peer-1", "sess-1"), "peer-1:sess-1");
  assertEquals(splitTabKey("peer-1:sess-1"), {
    peerId: "peer-1",
    sessionId: "sess-1",
  });
});

/** A WebSocket stand-in: connectEvents() only assigns handlers and closes
 * the socket, so the test drives the connection by hand. */
class FakeWebSocket {
  static readonly created: FakeWebSocket[] = [];

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.created.at(-1);
    if (!socket) throw new Error("connectEvents opened no WebSocket");
    return socket;
  }

  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.created.push(this);
  }

  /** Browsers fire `close` after close(), so a fake that did not would hide
   * whether the client treats the event as a drop. */
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

/** Run `body` with the page globals replaced by a stand-in page: both are
 * plain properties on globalThis in Deno, and the descriptors are put back
 * in a `finally` so nothing leaks into another test or file. */
function withPage(
  page: { protocol: string; host: string },
  body: () => void,
): void {
  const location = Object.getOwnPropertyDescriptor(globalThis, "location")!;
  const socket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
  FakeWebSocket.created.length = 0;
  Object.defineProperty(globalThis, "location", {
    value: page,
    configurable: true,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeWebSocket,
    configurable: true,
  });
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, "location", location);
    Object.defineProperty(globalThis, "WebSocket", socket);
  }
}

Deno.test("api-routing: connectEvents opens /ws of the page origin with the token", () => {
  // Same origin as the page that served the UI, upgraded for https — the
  // server serves UI, API and event stream together.
  withPage({ protocol: "https:", host: "hub:8443" }, () => {
    connectEvents(() => {}, () => {});
    assertEquals(
      FakeWebSocket.last().url,
      "wss://hub:8443/ws?token=tok%2Fen%2B1",
    );
  });

  withPage({ protocol: "http:", host: "127.0.0.1:8000" }, () => {
    connectEvents(() => {}, () => {});
    assertEquals(
      FakeWebSocket.last().url,
      "ws://127.0.0.1:8000/ws?token=tok%2Fen%2B1",
    );
  });
});

Deno.test("api-routing: connectEvents parses events, ignores garbage and reports one drop", () => {
  withPage({ protocol: "http:", host: "hub:8000" }, () => {
    const events: unknown[] = [];
    let opens = 0;
    let closes = 0;
    const close = connectEvents(
      (event) => events.push(event),
      () => closes++,
      () => opens++,
    );
    const socket = FakeWebSocket.last();

    // onOpen fires on every (re)connection: the caller re-syncs state.
    socket.onopen?.();
    assertEquals(opens, 1);

    socket.onmessage?.({ data: '{"type":"agent_end","sessionId":"s1"}' });
    assertEquals(events, [{ type: "agent_end", sessionId: "s1" }]);

    // A malformed frame is dropped instead of breaking the stream.
    socket.onmessage?.({ data: "<html>not json</html>" });
    assertEquals(events.length, 1);

    // The server went away: the caller is told once.
    socket.onclose?.();
    assertEquals(closes, 1);

    // The caller's own close() is not a drop — and closes the socket.
    close();
    assertEquals(socket.closed, true);
    assertEquals(closes, 1, "a deliberate close must not report a drop");
  });
});
