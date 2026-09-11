import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Model } from "../ai/types.ts";
import { CoreError } from "../errors.ts";
import type { SessionInfo } from "../types/session.ts";
import type { Workspace } from "../types/workspace.ts";
import type { AgentFactory } from "./factory.ts";
import {
  SessionPool,
  type SessionPoolDeps,
  type SessionResources,
} from "./pool.ts";
import type { SessionAgent } from "./session-agent.ts";

/** Records what the pool asked of one session's resources. */
interface TeardownLog {
  agentClosed: number;
  tasksClosed: number;
  backgroundKilled: number;
  mcpClosed: number;
}

function log(): TeardownLog {
  return { agentClosed: 0, tasksClosed: 0, backgroundKilled: 0, mcpClosed: 0 };
}

const WORKSPACE: Workspace = {
  id: "w1",
  name: "ws",
  folders: ["/tmp/ws"],
  createdAt: 0,
  chat: false,
};

function sessionInfo(id: string): SessionInfo {
  return {
    id,
    workspaceId: WORKSPACE.id,
    name: id,
    modelProvider: "faux",
    modelId: "m",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The slice of SessionAgent the pool touches. */
function fakeAgent(streaming: boolean): SessionAgent {
  return {
    isStreaming: streaming,
    messages: [],
    close: () => {},
    setThinkingLevel: () => {},
  } as unknown as SessionAgent;
}

/**
 * A pool over a fake factory. The factory fills the session's resources
 * (background / tasks / MCP) so the teardown order can be observed without
 * spawning anything.
 */
function makePool(options: { streaming?: boolean } = {}): {
  pool: SessionPool;
  teardown: TeardownLog;
} {
  const teardown = log();
  const deps = {
    requireModel: (provider: string, modelId: string) =>
      ({ id: modelId, provider }) as unknown as Model<"openai-completions">,
    requireWorkspace: () => WORKSPACE,
  } as unknown as SessionPoolDeps;
  const factory = {
    open(
      _session: SessionInfo,
      _workspace: Workspace,
      _messages: unknown[],
      resources: SessionResources,
    ): SessionAgent {
      const agent = fakeAgent(options.streaming === true);
      resources.agent = {
        ...agent,
        close: () => {
          teardown.agentClosed++;
        },
      } as SessionAgent;
      resources.background = {
        killAll: () => {
          teardown.backgroundKilled++;
          return Promise.resolve();
        },
      } as unknown as SessionResources["background"];
      resources.tasks = {
        close: () => {
          teardown.tasksClosed++;
        },
      } as unknown as SessionResources["tasks"];
      resources.mcp = {
        manager: {
          close: () => {
            teardown.mcpClosed++;
            return Promise.resolve();
          },
        },
      } as unknown as SessionResources["mcp"];
      return resources.agent;
    },
  } as unknown as AgentFactory;
  return { pool: new SessionPool(deps, factory), teardown };
}

Deno.test("pool.require throws not_found for an unopened session", () => {
  const { pool } = makePool();
  const error = assertThrows(
    () => pool.require("missing"),
    CoreError,
  );
  assertEquals((error as CoreError).kind, "not_found");
  assertEquals(pool.get("missing"), undefined);
  assertEquals(pool.lastError("missing"), undefined);
});

Deno.test("pool snapshot getters are empty for an unopened session", () => {
  const { pool } = makePool();
  assertEquals(pool.getTodo("missing"), []);
  assertEquals(pool.getTasks("missing"), []);
  assertEquals(pool.getBackground("missing"), []);
});

Deno.test("pool.close tears down every resource of the session", async () => {
  const { pool, teardown } = makePool();
  const session = sessionInfo("s1");
  pool.open(session, WORKSPACE, []);

  await pool.close(session.id);
  assertEquals(teardown.agentClosed, 1);
  assertEquals(teardown.tasksClosed, 1);
  assertEquals(teardown.backgroundKilled, 1);
  assertEquals(teardown.mcpClosed, 1);
  // The session is forgotten: a later require fails.
  assertThrows(() => pool.require(session.id), CoreError);
});

Deno.test("pool.close is a no-op for an unknown session", async () => {
  const { pool, teardown } = makePool();
  await pool.close("missing");
  assertEquals(teardown.agentClosed, 0);
});

Deno.test("pool.closeAll tears down every open session", async () => {
  const { pool, teardown } = makePool();
  pool.open(sessionInfo("s1"), WORKSPACE, []);
  pool.open(sessionInfo("s2"), WORKSPACE, []);

  await pool.closeAll();
  assertEquals(teardown.agentClosed, 2);
  assertEquals(teardown.tasksClosed, 2);
  assertEquals(teardown.backgroundKilled, 2);
  assertEquals(teardown.mcpClosed, 2);
  assertThrows(() => pool.require("s1"), CoreError);
  assertThrows(() => pool.require("s2"), CoreError);
});

Deno.test("pool.applyChange refuses while a session is streaming", () => {
  const { pool, teardown } = makePool({ streaming: true });
  const session = sessionInfo("s1");
  pool.open(session, WORKSPACE, []);

  let mutated = false;
  const error = assertThrows(
    () =>
      pool.applyChange([session], () => {
        mutated = true;
      }),
    CoreError,
  );
  assertEquals((error as CoreError).kind, "conflict");
  // The guard runs before the mutation: nothing was half-applied.
  assertEquals(mutated, false);
  assertEquals(teardown.agentClosed, 0);
});

Deno.test("pool.applyChange mutates and rebuilds idle sessions", () => {
  const { pool, teardown } = makePool();
  const session = sessionInfo("s1");
  pool.open(session, WORKSPACE, []);

  let mutated = false;
  pool.applyChange([session], () => {
    mutated = true;
  });
  assertEquals(mutated, true);
  // Rebuilding closes the previous agent exactly once.
  assertEquals(teardown.agentClosed, 1);
  assert(pool.get(session.id) !== undefined);
});

Deno.test("pool.applyChange with no open sessions only runs the mutation", () => {
  const { pool, teardown } = makePool();
  let mutated = false;
  pool.applyChange([sessionInfo("closed")], () => {
    mutated = true;
  });
  assertEquals(mutated, true);
  assertEquals(teardown.agentClosed, 0);
});

Deno.test("pool.setThinkingLevel ignores a closed session", () => {
  const { pool } = makePool();
  // No throw: the level is read from settings on the next open().
  pool.setThinkingLevel("missing", "high");
});

Deno.test("pool.rebuild ignores a session that is not open", () => {
  const { pool, teardown } = makePool();
  pool.rebuild(sessionInfo("never-opened"));
  assertEquals(teardown.agentClosed, 0);
});
