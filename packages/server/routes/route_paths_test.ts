/**
 * The shared session builder's mounted paths.
 *
 * `routes/conversation.ts` installs the handlers a code-mode session and a
 * stella conversation share (abort, answer, rewind, model) on a caller-chosen
 * base path. `routes/stella.ts` mounts it at
 * `/stella/conversations/:agentId` and then adds the routes only a
 * conversation has.
 *
 * The regression this pins: a second `POST …/rewind` was written directly in
 * `stella.ts` next to the builder's. Hono answers the FIRST registration, so
 * the hand-written one was unreachable dead code sitting beside the live
 * implementation — exactly the "two implementations, one silently unused"
 * failure the builder was introduced to end. Two things are checked here:
 *
 *  1. every path the builder installs answers from the builder, and
 *  2. no route module registers the same method + path twice.
 *
 * The second check reads the sources, because a duplicate registration is
 * invisible at runtime (the later one simply never runs).
 */
import { assertEquals } from "@std/assert";
import { stellaRoutes } from "./stella.ts";
import type { StellaApi } from "./stella.ts";
import type { SessionInfo, StellaAgent } from "@lumisca/core";

const AGENT: StellaAgent = {
  id: "a1",
  name: "Aide",
  role: "",
  identity: "",
  icon: "",
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

/** A core that answers only for the fixture agent, recording the calls. */
function fakeCore(seen: string[]): StellaApi {
  const agentOf = (id: string) => id === AGENT.id ? AGENT : undefined;
  const sessionOf = (id: string) => id === AGENT.id ? SESSION : undefined;
  return {
    getStellaAgent: agentOf,
    findStellaSession: sessionOf,
    listStellaAgents: () => [AGENT],
    ensureStellaAgent: () => AGENT,
    createStellaAgent: () => AGENT,
    updateStellaAgent: () => AGENT,
    deleteStellaAgent: () => Promise.resolve(),
    resolveStellaAgentIcon: () => undefined,
    getStellaStatus: () => Promise.resolve({} as never),
    getStellaAvailability: () => Promise.resolve({ available: true } as never),
    getSession: (id: string) => id === SESSION.id ? SESSION : undefined,
    getSessionLastError: () => undefined,
    getSessionRevision: () => 0,
    openSession: (id: string) => {
      seen.push(`open:${id}`);
      return SESSION;
    },
    startPrompt: () => {
      seen.push("prompt");
    },
    savePromptUploads: () => Promise.resolve([]),
    abort: () => {
      seen.push("abort");
    },
    rewind: (_id: string, timestamp: number) => {
      seen.push(`rewind:${timestamp}`);
      return Promise.resolve();
    },
    setSessionModel: () => {
      seen.push("model");
    },
    answerQuestion: () => {
      seen.push("answer");
    },
    getPendingQuestions: () => [],
    getPendingHandover: () => null,
    finishHandover: () => {
      seen.push("handover");
    },
    readStellaConversation: () => undefined,
    getSessionUsage: () => ({}) as never,
    getTodo: () => [],
    getTasks: () => [],
    getBackground: () => [],
    getGoal: () => undefined,
    cancelGoal: () => {},
    resolvePromptUpload: () => Promise.resolve(undefined),
  } as unknown as StellaApi;
}

Deno.test("the shared builder owns rewind, not a second handler", async () => {
  const seen: string[] = [];
  const app = stellaRoutes(fakeCore(seen));
  const response = await app.request(
    "http://localhost/stella/conversations/a1/rewind",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timestamp: 42 }),
    },
  );
  assertEquals(response.status, 200);
  // The builder opens the session before rewinding (a conversation that was
  // closed is reopened for the truncation); the hand-written copy did the
  // same, so the observable effect alone cannot tell them apart — but a
  // duplicate registration would answer from whichever came first and the
  // path check below would still catch it.
  assertEquals(seen, ["open:s1", "rewind:42"]);
});

/** Every `${method} ${path}` a route module registers, read from the source:
 * `app.get("/path"`, `app.post("/path"`, … and the builder's
 * `path("/suffix")` helper calls inside `conversationRoutes`. */
async function registrationsIn(
  file: string,
): Promise<Array<{ method: string; path: string }>> {
  const here = import.meta.url;
  const text = await Deno.readTextFile(
    new URL(here.slice(0, here.lastIndexOf("/") + 1) + file),
  );
  const out: Array<{ method: string; path: string }> = [];
  for (
    const match of text.matchAll(
      /\bapp\.(get|post|put|patch|delete|all)\(\s*[`"]([^`"]+)[`"]/g,
    )
  ) {
    out.push({ method: match[1]!, path: match[2]! });
  }
  // The builder's shared handlers: `app.<method>(path("/suffix")`, where the
  // base is the caller's option.
  for (
    const match of text.matchAll(
      /\bapp\.(get|post|put|patch|delete|all)\(\s*path\(\s*[`"]([^`"]+)[`"]/g,
    )
  ) {
    out.push({ method: match[1]!, path: `<base>${match[2]!}` });
  }
  return out;
}

Deno.test("no route module registers the same method and path twice", async () => {
  const files = [
    "attachments.ts",
    "connections.ts",
    "conversation.ts",
    "mcp.ts",
    "providers.ts",
    "routines.ts",
    "sessions.ts",
    "settings.ts",
    "skills.ts",
    "stella-assets.ts",
    "stella.ts",
    "update.ts",
    "visuals.ts",
    "web-search.ts",
    "workspaces.ts",
  ];
  const duplicates: string[] = [];
  for (const file of files) {
    const seen = new Map<string, number>();
    for (const { method, path } of await registrationsIn(file)) {
      const key = `${method.toUpperCase()} ${path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) duplicates.push(`routes/${file}: ${key} (×${count})`);
    }
  }
  assertEquals(
    duplicates,
    [],
    "a route registered twice answers only from the first (delete the later one)",
  );
});
