import type {
  SessionInfo,
  StellaAgent,
  StellaShareRequest,
} from "@lumisca/core";
import { assertEquals } from "@std/assert";
import type { StellaApi } from "./stella.ts";
import { stellaRoutes } from "./stella.ts";
import { stellaApiStub } from "./test-stubs.ts";

/**
 * The conversation's folder endpoints: the answer to `share_request`
 * (lent / declined) and the desktop app's answer to `share_disconnect`.
 *
 * What is checked here is the path the answer takes, not the wait behind it
 * (share/request_test.ts owns that): each endpoint reaches the one core method
 * that settles the request, and a body that names nothing usable is refused
 * before it does.
 */

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
  workspaceId: "ws",
  name: "Aide",
  modelProvider: "faux",
  modelId: "small",
  createdAt: 0,
  updatedAt: 0,
  stella: true,
  agentId: "a1",
} as SessionInfo;

const PENDING: StellaShareRequest = {
  kind: "lend",
  toolCallId: "t1",
  reason: "read the exports",
  expiresAt: Date.now() + 15 * 60_000,
};

function fakeCore(
  seen: string[],
  pending: StellaShareRequest | null = PENDING,
): StellaApi {
  const agentOf = (id: string) => (id === AGENT.id ? AGENT : undefined);
  const sessionOf = (id: string) => (id === AGENT.id ? SESSION : undefined);
  return stellaApiStub({
    getStellaAgent: agentOf,
    findStellaSession: sessionOf,
    ensureStellaAgent: () => Promise.resolve(AGENT),
    getStellaStatus: () => Promise.resolve({} as never),
    getOrCreateStellaSession: () => Promise.resolve(SESSION),
    startStellaOnboarding: () => false,
    getSession: (id: string) => (id === SESSION.id ? SESSION : undefined),
    getSessionLastError: () => undefined,
    getSessionRevision: () => 0,
    getThinkingState: () => ({ thinkingLevel: "off", thinkingLevels: [] }),
    getAgent: () => ({ isStreaming: false }),
    readStellaConversation: () => ({ items: [], older: null }),
    getPendingQuestions: () => [],
    getPendingHandover: () => null,
    getPendingEnvRequest: () => null,
    getPendingShareRequest: () => pending,
    getShares: () => [],
    finishShareLend: (sessionId: string, toolCallId?: string) => {
      seen.push(`lend:${sessionId}:${toolCallId ?? ""}`);
    },
    declineShareRequest: (sessionId: string, toolCallId?: string) => {
      seen.push(`decline:${sessionId}:${toolCallId ?? ""}`);
    },
    finishShareDisconnect: (sessionId: string, toolCallId: string) => {
      seen.push(`disconnect:${sessionId}:${toolCallId}`);
    },
    failShareDisconnect: (
      sessionId: string,
      toolCallId: string,
      error: string,
    ) => {
      seen.push(`failed:${sessionId}:${toolCallId}:${error}`);
    },
  });
}

async function post(
  seen: string[],
  path: string,
  body: unknown,
  pending: StellaShareRequest | null = PENDING,
): Promise<Response> {
  const app = stellaRoutes(fakeCore(seen, pending));
  app.onError((error, c) => {
    const status =
      (error as { status?: number }).status ??
      (error as { kind?: string }).kind ??
      500;
    return c.json(
      { error: String(error) },
      typeof status === "number" ? status : 500,
    );
  });
  return await app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("folder request: a loan answers the waiting card", async () => {
  const seen: string[] = [];
  const response = await post(seen, "/stella/conversations/a1/share/lend", {
    toolCallId: "t1",
  });
  assertEquals(response.status, 200);
  // No folder is named here: the server's own list of loans is what the tool
  // reads, so a client cannot tell the model a folder exists.
  assertEquals(seen, ["lend:s1:t1"]);
});

Deno.test("folder request: a refusal answers it too", async () => {
  const seen: string[] = [];
  const response = await post(seen, "/stella/conversations/a1/share/decline", {
    toolCallId: "t1",
  });
  assertEquals(response.status, 200);
  assertEquals(seen, ["decline:s1:t1"]);
});

Deno.test("folder request: a tool call id that is not a string is refused", async () => {
  const seen: string[] = [];
  const response = await post(seen, "/stella/conversations/a1/share/lend", {
    toolCallId: 7,
  });
  assertEquals(response.status, 400);
  assertEquals(seen, []);
});

Deno.test("folder disconnect: the app's success settles the wait", async () => {
  const seen: string[] = [];
  const response = await post(
    seen,
    "/stella/conversations/a1/share/disconnect",
    { toolCallId: "t9", ok: true },
    {
      kind: "disconnect",
      toolCallId: "t9",
      id: "g1",
      name: "proj",
      expiresAt: 0,
    },
  );
  assertEquals(response.status, 200);
  assertEquals(seen, ["disconnect:s1:t9"]);
});

Deno.test("folder disconnect: the app's reason reaches the tool as given", async () => {
  const seen: string[] = [];
  const response = await post(
    seen,
    "/stella/conversations/a1/share/disconnect",
    { toolCallId: "t9", ok: false, error: "the shell refused" },
    {
      kind: "disconnect",
      toolCallId: "t9",
      id: "g1",
      name: "proj",
      expiresAt: 0,
    },
  );
  assertEquals(response.status, 200);
  assertEquals(seen, ["failed:s1:t9:the shell refused"]);
});

Deno.test("folder disconnect: a failure without a reason is refused", async () => {
  // The reason is what the model reads instead of "it did not work": an empty
  // one would be an answer with nothing in it.
  const seen: string[] = [];
  const response = await post(
    seen,
    "/stella/conversations/a1/share/disconnect",
    { toolCallId: "t9", ok: false, error: "  " },
    {
      kind: "disconnect",
      toolCallId: "t9",
      id: "g1",
      name: "proj",
      expiresAt: 0,
    },
  );
  assertEquals(response.status, 400);
  assertEquals(seen, []);
});

Deno.test("folder request: the snapshot carries the pending card", async () => {
  // `share_request` events are never replayed, so a client that reconnects
  // while the run is blocked learns about the card from the snapshot alone.
  const seen: string[] = [];
  const app = stellaRoutes(fakeCore(seen));
  const response = await app.request(
    "http://localhost/stella/conversations/a1/messages",
  );
  assertEquals(response.status, 200);
  const snapshot = (await response.json()) as {
    shareRequest: StellaShareRequest | null;
  };
  assertEquals(snapshot.shareRequest, PENDING);
});
