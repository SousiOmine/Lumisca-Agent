import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { CoreError, LumiscaCore } from "../mod.ts";
import { McpAttachment } from "../mcp/attachment.ts";
import { parseMcpConfig } from "../mcp/config.ts";
import { McpManager } from "../mcp/manager.ts";
import { createBrowserTools } from "../browser/tools.ts";
import type { BrowserBackend } from "../browser/types.ts";
import {
  type ThinkingLevel,
  TOOL_BROWSER_OPEN,
  TOOL_CALL,
  TOOL_SEARCH,
} from "../shared.ts";
import type { ClientEvent } from "../types/event.ts";
import type { NotificationPayload } from "../types/notification.ts";
import type { Workspace } from "../types/workspace.ts";
import { ToolRegistry } from "./registry.ts";
import {
  createSendMessageTool,
  createTaskOutputTool,
  createTaskTool,
  MAX_SUBAGENTS,
  TaskHub,
} from "./task.ts";

function makeWorkspace(root: string): Workspace {
  return {
    id: "ws",
    name: "ws",
    folders: [root],
    createdAt: Date.now(),
    chat: false,
  };
}

/** A stream function that never settles: sub-agents stay running until the
 * test tears the hub down. */
const hangingStream: StreamFn = () => new Promise<never>(() => {});

interface HubFixture {
  core: LumiscaCore;
  events: ClientEvent[];
  root: string;
  hub: TaskHub;
  model: Model<Api>;
}

/** A hub with the given stream function, a real model from the faux
 * provider, and a recording event sink. */
function makeHub(streamFn: StreamFn = hangingStream): HubFixture {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const model = core.models.getModel(faux.provider.id, faux.getModel().id)!;
  const events: ClientEvent[] = [];
  const root = Deno.makeTempDirSync({ prefix: "lumisca-task-" });
  const hub = new TaskHub({
    sessionId: "session-1",
    resolveRuntime: () => ({
      workspace: makeWorkspace(root),
      model,
      thinkingLevel: "off",
    }),
    streamFn,
    emit: (event) => events.push(event),
  });
  return { core, events, root, hub, model };
}

/** A hub whose sub-agents stream from the scripted faux responses. */
function makeScriptedHub() {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const model = core.models.getModel(faux.provider.id, faux.getModel().id)!;
  const streamFn = core.models.models.streamSimple.bind(core.models.models);
  const events: ClientEvent[] = [];
  const root = Deno.makeTempDirSync({ prefix: "lumisca-task-" });
  const hub = new TaskHub({
    sessionId: "session-1",
    resolveRuntime: () => ({
      workspace: makeWorkspace(root),
      model,
      thinkingLevel: "off",
    }),
    streamFn,
    emit: (event) => events.push(event),
  });
  return { faux, core, events, root, hub };
}

/** In-memory browser backend recording opens (only open is reachable in
 * these tests — the tools are exercised through browser_open only). */
class FakeBrowserBackend implements BrowserBackend {
  opens: Array<{ url: string; width?: number; height?: number }> = [];

  open(options: { url: string; width?: number; height?: number }) {
    this.opens.push(options);
    return Promise.resolve({
      url: options.url,
      title: "Lab",
      readyState: "complete",
    });
  }
  observe(): Promise<never> {
    throw new Error("unused");
  }
  act(): Promise<never> {
    throw new Error("unused");
  }
  wait(): Promise<never> {
    throw new Error("unused");
  }
  screenshot(): Promise<never> {
    throw new Error("unused");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Poll until `predicate` holds (bounded so a hang fails the test). */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A stream function that fails the first call with a provider rate-limit
 * (429) error, then succeeds — exercising the sub-agent's backoff retry. */
function rateLimitThenOk(): StreamFn {
  let calls = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    if (calls++ < 1) {
      stream.push({
        type: "error",
        reason: "error",
        error: fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "OpenAI API error (429): rate_limit_exceeded",
        }),
      });
      stream.end();
      return stream;
    }
    stream.push({ type: "start", partial: fauxAssistantMessage("") });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "done",
      partial: fauxAssistantMessage("done"),
    });
    stream.end(fauxAssistantMessage("done"));
    return stream;
  };
}

Deno.test("sub-agent retries a rate-limited turn then succeeds", async () => {
  const { hub, events } = makeHub(rateLimitThenOk());
  hub.spawn("session-1", 0, "general", "desc", "prompt");
  await waitFor(() => hub.list()[0]?.status === "finished", "task finish");
  assertEquals(hub.list()[0]?.status, "finished");
  const end = events.find((e) => e.type === "task_end");
  assertEquals(end?.status, "finished");
});

/** Concatenate the text blocks of a message (works on the agent's message
 * union, which mixes content-carrying and non-content variants). */
function messageText(message: unknown): string {
  const m = message as {
    role?: string;
    title?: string;
    body?: string;
    content?: unknown;
  };
  if (m.role === "notification") {
    return (m.body?.length ?? 0) > 0
      ? `${m.title}\n${m.body}`
      : (m.title ?? "");
  }
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "").join("");
}

// --- hub: spawn and lifecycle -------------------------------------------------

Deno.test("spawn returns a running snapshot immediately and emits task_start", () => {
  const { events, hub } = makeHub();
  try {
    const info = hub.spawn("session-1", 0, "explore", "調査", "Do research");
    assertEquals(info.agentId, "agent_1");
    assertEquals(info.parentAgentId, "session-1");
    assertEquals(info.subagentType, "explore");
    assertEquals(info.status, "running");
    assert(info.startedAt > 0, "startedAt missing");
    assertEquals(events.filter((e) => e.type === "task_start").length, 1);
    const start = events.find((e) => e.type === "task_start")!;
    assertEquals(start.agentId, "agent_1");
    assertEquals(start.subagentType, "explore");
    assertEquals(start.description, "調査");
  } finally {
    hub.close();
  }
});

Deno.test("the sub-agent runtime is resolved at spawn time", () => {
  const { events, hub, model, root } = makeHub();
  try {
    // The resolver (refreshed on every session open) is read per spawn, so
    // model/thinking-level changes apply to new sub-agents without waiting
    // for a session rebuild.
    let resolutions = 0;
    let level: ThinkingLevel = "off";
    hub.setRuntimeResolver(() => {
      resolutions++;
      return { workspace: makeWorkspace(root), model, thinkingLevel: level };
    });
    hub.spawn("session-1", 0, "explore", "調査", "Do research");
    level = "high";
    hub.spawn("session-1", 0, "explore", "調査2", "Do research");
    assertEquals(resolutions, 2);
    assertEquals(
      events.filter((e) => e.type === "task_start").length,
      2,
    );
  } finally {
    hub.close();
  }
});

Deno.test("the per-session concurrency limit is enforced", () => {
  const { hub } = makeHub();
  try {
    for (let i = 0; i < MAX_SUBAGENTS; i++) {
      hub.spawn("session-1", 0, "explore", `job ${i}`, "work");
    }
    let message = "";
    try {
      hub.spawn("session-1", 0, "explore", "one too many", "work");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Too many agents running"), message);
  } finally {
    hub.close();
  }
});

Deno.test("close aborts every running sub-agent and settles waiters", async () => {
  const { events, hub } = makeHub();
  const info = hub.spawn("session-1", 0, "explore", "調査", "Do research");
  // A waiter registered before the close receives the aborted snapshot
  // instead of hanging.
  const waited = hub.wait(info.agentId, "session-1", 300);
  hub.close();
  const snapshot = await waited;
  assertEquals(snapshot.status, "aborted");
  assertEquals(hub.list()[0]!.status, "aborted");
  assertEquals(
    events.filter((e) => e.type === "task_end" && e.status === "aborted")
      .length,
    1,
  );
});

// --- hub: send_message (mesh) --------------------------------------------------

Deno.test("send_message rejects unknown, finished, and parentless targets", async () => {
  const { faux, hub } = makeScriptedHub();
  try {
    assertThrowsCoreError(
      () => hub.sendMessage("session-1", "agent_9", "hi", "hello"),
      "Unknown agent: agent_9. Known agents: session-1",
      "not_found",
    );

    // The main agent has no parent to address.
    assertThrowsCoreError(
      () => hub.sendMessage("session-1", "parent", "hi", "hello"),
      "The main agent has no parent",
      "invalid",
    );

    // A finished sub-agent no longer accepts messages.
    faux.setResponses([fauxAssistantMessage("done")]);
    const info = hub.spawn("session-1", 0, "explore", "調査", "Do research");
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertThrowsCoreError(
      () => hub.sendMessage("session-1", info.agentId, "hi", "hello"),
      "Agent is not active: agent_1 (finished)",
      "unavailable",
    );
  } finally {
    hub.close();
  }
});

Deno.test("send_message delivers to the parent and to a running sub-agent", () => {
  const { hub } = makeHub();
  const received: NotificationPayload[] = [];
  hub.setParentDelivery({
    isActive: () => true,
    deliver: (payload) => received.push(payload),
  });
  try {
    const info = hub.spawn("session-1", 0, "general", "調査", "Do research");

    // Sub-agent → parent (the "parent" alias resolves to the main agent).
    const toParent = hub.sendMessage(
      info.agentId,
      "parent",
      "need input",
      "Which file?",
    );
    assertEquals(toParent.deliveredTo, "session-1");
    assertEquals(received, [{
      kind: "message",
      title: "[Message from agent_1 (need input)]",
      body: "Which file?",
      status: "neutral",
    }]);

    // Main agent → running sub-agent: steered into its loop.
    const toSub = hub.sendMessage(
      "session-1",
      info.agentId,
      "hint",
      "Look at src/",
    );
    assertEquals(toSub.deliveredTo, "agent_1");
  } finally {
    hub.close();
  }
});

// --- hub: task_output wait ------------------------------------------------------

Deno.test("wait returns the current state on timeout", async () => {
  const { hub } = makeHub();
  try {
    const info = hub.spawn("session-1", 0, "explore", "調査", "Do research");
    const before = Date.now();
    const snapshot = await hub.wait(info.agentId, "session-1", 1);
    assert(Date.now() - before >= 800, "wait did not honor the timeout");
    assertEquals(snapshot.status, "running");
  } finally {
    hub.close();
  }
});

Deno.test("wait rejects when the caller's run aborts", async () => {
  const { hub } = makeHub();
  try {
    const info = hub.spawn("session-1", 0, "explore", "調査", "Do research");

    // An already-aborted signal settles immediately.
    const aborted = new AbortController();
    aborted.abort();
    await assertRejects(
      () => hub.wait(info.agentId, "session-1", 30, aborted.signal),
      CoreError,
      "Cancelled while waiting for agent_1",
    );

    // An abort mid-wait settles the pending wait.
    const controller = new AbortController();
    const waiting = hub.wait(info.agentId, "session-1", 30, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assertRejects(
      () => waiting,
      CoreError,
      "Cancelled while waiting for agent_1",
    );
  } finally {
    hub.close();
  }
});

Deno.test("wait on a finished task resolves immediately with the result", async () => {
  const { faux, hub } = makeScriptedHub();
  try {
    faux.setResponses([fauxAssistantMessage("Answer: 42")]);
    const info = hub.spawn("session-1", 0, "general", "調査", "Do research");
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    const snapshot = await hub.wait(info.agentId, "session-1", 30);
    assertEquals(snapshot.status, "finished");
    assert(snapshot.text.includes("Answer: 42"), snapshot.text);
  } finally {
    hub.close();
  }
});

// --- sub-agent tool sets (depth / type gating) -----------------------------------

Deno.test("a general sub-agent can delegate once more, but not beyond the depth limit", async () => {
  const { faux, hub } = makeScriptedHub();
  try {
    // Depth-1 general agent: has the task tool; its first turn spawns a
    // grandchild (depth 2), which answers; the agent wraps up and finally
    // reacts to the grandchild's completion notification (a fourth turn).
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Delegating deeper."),
        fauxToolCall("task", {
          subagent_type: "explore",
          description: "深掘り",
          prompt: "Look deeper",
        }),
      ]),
      fauxAssistantMessage("Deep answer."),
      fauxAssistantMessage("All done."),
      fauxAssistantMessage("Received the deep answer."),
    ]);
    hub.spawn("session-1", 0, "general", "調査", "Do research");
    await waitFor(() => hub.list().length === 2, "grandchild spawn");
    await waitFor(
      () => hub.list().every((t) => t.status === "finished"),
      "chain finish",
    );
    const [newest] = hub.list();
    assertEquals(newest!.agentId, "agent_2");
    assertEquals(newest!.parentAgentId, "agent_1");
  } finally {
    hub.close();
  }
});

Deno.test("a depth-2 agent has no task tool: the call fails instead of spawning", async () => {
  const { faux, hub } = makeScriptedHub();
  try {
    // Spawned at parent depth 1, so its own depth is 2 (the limit).
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Trying to delegate."),
        fauxToolCall("task", {
          subagent_type: "explore",
          description: "さらに深く",
          prompt: "Go deeper",
        }),
      ]),
      fauxAssistantMessage("Delegation failed."),
    ]);
    hub.spawn("session-1", 1, "general", "調査", "Do research");
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list().length, 1, "a grandchild was spawned");
    const snapshot = hub.list()[0]!;
    assert(
      snapshot.text.includes("Delegation failed."),
      snapshot.text,
    );
  } finally {
    hub.close();
  }
});

Deno.test("an explore sub-agent has no task tool", async () => {
  const { faux, hub } = makeScriptedHub();
  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Trying to delegate."),
        fauxToolCall("task", {
          subagent_type: "explore",
          description: "委譲",
          prompt: "Do it",
        }),
      ]),
      fauxAssistantMessage("Delegation failed."),
    ]);
    hub.spawn("session-1", 0, "explore", "調査", "Do research");
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list().length, 1, "a sub-agent was spawned");
  } finally {
    hub.close();
  }
});

// --- tools: validation -----------------------------------------------------------

Deno.test("the task tool rejects an unknown subagent type", () => {
  const { hub } = makeHub();
  try {
    const tool = createTaskTool(hub, "session-1", 0);
    assertThrowsCoreError(
      () =>
        tool.execute("1", {
          subagent_type: "intern" as "explore",
          description: "調査",
          prompt: "Do research",
        }, undefined),
      'Unknown subagent_type "intern": expected "general" or "explore"',
      "invalid",
    );
  } finally {
    hub.close();
  }
});

Deno.test("the task_output tool validates timeout_sec and unknown ids", async () => {
  const { hub } = makeHub();
  try {
    const tool = createTaskOutputTool(hub, "session-1");

    await assertRejects(
      () =>
        tool.execute("1", { agent_id: "agent_1", timeout_sec: 0 }, undefined),
      CoreError,
      "timeout_sec must be between 1 and 300",
    );
    await assertRejects(
      () => tool.execute("2", { agent_id: "agent_9" }, undefined),
      CoreError,
      "Unknown agent: agent_9. Known agents: session-1",
    );
  } finally {
    hub.close();
  }
});

Deno.test("the send_message tool reports the delivery target", () => {
  const { hub } = makeHub();
  const received: NotificationPayload[] = [];
  hub.setParentDelivery({
    isActive: () => true,
    deliver: (payload) => received.push(payload),
  });
  try {
    hub.spawn("session-1", 0, "explore", "調査", "Do research");
    const tool = createSendMessageTool(hub, "agent_1");
    const result = tool.execute("1", {
      to: "parent",
      summary: "question",
      message: "Where?",
    }, undefined);
    return result.then((r) => {
      assertEquals(r.details.to, "session-1");
      assertEquals(received[0], {
        kind: "message",
        title: "[Message from agent_1 (question)]",
        body: "Where?",
        status: "neutral",
      });
    });
  } finally {
    hub.close();
  }
});

/** Assert that `fn` throws a CoreError with the expected message and kind. */
function assertThrowsCoreError(
  fn: () => void,
  message: string,
  kind: string,
): void {
  try {
    fn();
    assert(false, `expected an error: ${message}`);
  } catch (error) {
    assertEquals(
      error instanceof Error ? error.message : String(error),
      message,
    );
    assertEquals((error as { kind?: string }).kind, kind);
  }
}

// --- end to end: the parent agent ------------------------------------------------

Deno.test("a task runs in the background and its completion reaches the parent", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const events: ClientEvent[] = [];
  const unsubscribe = core.subscribe((event) => events.push(event));
  const root = await Deno.makeTempDir({ prefix: "lumisca-task-e2e-" });
  try {
    const ws = await core.createWorkspace("ws", [root]);
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });

    // Turn 1: the parent delegates. The sub-agent answers (it streams first:
    // its request is issued inside the task tool, before the parent's next
    // turn); turn 2 wraps the parent run up; turn 3 reacts to the
    // completion notification (steered in, or a fresh run if already idle).
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Delegating."),
        fauxToolCall("task", {
          subagent_type: "general",
          description: "調査",
          prompt: "Find the answer",
        }),
      ]),
      fauxAssistantMessage("Answer: 42"),
      fauxAssistantMessage("Launched."),
      fauxAssistantMessage("The task finished."),
    ]);
    await core.prompt(session.id, "Do the research in the background");

    const agent = core.getAgent(session.id)!;
    await waitFor(
      () => agent.messages.some((m) => messageText(m) === "The task finished."),
      "the parent's reaction to the completion",
    );
    const transcript = agent.messages.map(messageText);
    assert(
      transcript.some((t) =>
        t.startsWith("[Task agent_1 (調査) finished]") &&
        t.includes("Answer: 42")
      ),
      `completion notification missing: ${JSON.stringify(transcript)}`,
    );
    assert(
      events.some((e) => e.type === "task_start" && e.agentId === "agent_1"),
      "task_start missing",
    );
    assert(
      events.some((e) =>
        e.type === "task_end" && e.agentId === "agent_1" &&
        e.status === "finished"
      ),
      "task_end missing",
    );
    assert(
      events.some((e) => e.type === "task_delta" && e.agentId === "agent_1"),
      "task_delta missing",
    );
  } finally {
    unsubscribe();
    core.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a waiting task_output receives the result and suppresses the notification", async () => {
  // The sub-agent's answer streams slowly enough (a long padded text) that
  // the parent registers its blocking task_output wait before the sub-agent
  // finishes; the completion notification must then be suppressed.
  const faux = fauxProvider({ tokensPerSecond: 50 });
  const core = LumiscaCore.forTesting([faux.provider]);
  const root = await Deno.makeTempDir({ prefix: "lumisca-task-wait-" });
  try {
    const ws = await core.createWorkspace("ws", [root]);
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });
    const longAnswer = "Answer: 42. " + "padding ".repeat(120);

    // Turn 1: delegate; the sub-agent answers slowly; turn 2: wait for it;
    // turn 3: use the result.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Delegating."),
        fauxToolCall("task", {
          subagent_type: "general",
          description: "調査",
          prompt: "Find the answer",
        }),
      ]),
      fauxAssistantMessage(longAnswer),
      fauxAssistantMessage([
        fauxText("Waiting."),
        fauxToolCall("task_output", { agent_id: "agent_1", wait: true }),
      ]),
      fauxAssistantMessage("Got the result."),
    ]);
    await core.prompt(session.id, "Do the research and wait for it");

    const agent = core.getAgent(session.id)!;
    await waitFor(
      () => agent.messages.some((m) => messageText(m) === "Got the result."),
      "the parent's reaction to the result",
    );
    const transcript = agent.messages.map(messageText);
    assert(
      transcript.some((t) => t.includes("Answer: 42")),
      `task_output result missing: ${JSON.stringify(transcript)}`,
    );
    assert(
      !transcript.some((t) => t.startsWith("[Task agent_1")),
      `the completion notification was not suppressed: ${
        JSON.stringify(transcript)
      }`,
    );
  } finally {
    core.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sub-agents survive a session rebuild and remain listed", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const root = await Deno.makeTempDir({ prefix: "lumisca-task-rebuild-" });
  try {
    const ws = await core.createWorkspace("ws", [root]);
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Delegating."),
        fauxToolCall("task", {
          subagent_type: "explore",
          description: "調査",
          prompt: "Find the answer",
        }),
      ]),
      fauxAssistantMessage("Answer: 42"),
      fauxAssistantMessage("Launched."),
    ]);
    await core.prompt(session.id, "Start research in the background");
    await waitFor(
      () => core.getTasks(session.id).some((t) => t.status === "finished"),
      "the task to finish",
    );

    // A model change rebuilds the agent; the task hub is session-owned and
    // keeps its tasks.
    core.setSessionModel(session.id, faux.provider.id, faux.getModel().id);
    const tasks = core.getTasks(session.id);
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0]!.agentId, "agent_1");
    assertEquals(tasks[0]!.status, "finished");
  } finally {
    core.close();
    await Deno.remove(root, { recursive: true });
  }
});

// --- sub-agents and MCP tools ----------------------------------------------------

/** A minimal streamable-HTTP MCP server exposing one `ping` tool (mirrors
 * mcp_test.ts): answers initialize with a session id and tools/call over
 * plain JSON. `delayMs` stalls the tools/list answer — tests use it to make
 * one attachment's discovery land deterministically after another's. */
function startPingMcpServer(
  delayMs = 0,
): { port: number; shutdown: () => void } {
  let sessionId: string | null = null;
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, onListen: () => {}, signal: controller.signal },
    async (req) => {
      if (req.method !== "POST") return new Response("nope", { status: 405 });
      const body = await req.json() as {
        id?: string;
        method?: string;
      };
      if (body.method === "initialize") {
        sessionId = crypto.randomUUID();
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "http-fake", version: "1" },
            },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Mcp-Session-Id": sessionId,
            },
          },
        );
      }
      if (body.method === "tools/list") {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{
              name: "ping",
              description: "Pings",
              inputSchema: { type: "object" },
            }],
          },
        });
      }
      if (body.method === "tools/call") {
        const sentSession = req.headers.get("mcp-session-id");
        const text = sentSession === sessionId
          ? "pong (session ok)"
          : `pong (session missing: ${sentSession ?? "none"})`;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text }] },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `unknown: ${body.method}` },
      });
    },
  );
  return { port: server.addr.port, shutdown: () => controller.abort() };
}

/** A session's shared MCP attachment pointed at the ping server.
 * `serverName` distinguishes attachments of different "configs" (each one
 * yields a distinct tool name). */
async function makePingAttachment(
  root: string,
  serverName = "remote",
): Promise<{ attachment: McpAttachment; shutdown: () => void }> {
  const mcp = startPingMcpServer();
  const config = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        [serverName]: { url: `http://127.0.0.1:${mcp.port}/mcp` },
      },
    }),
    join(root, ".mcp.json"),
  );
  const attachment = new McpAttachment(new McpManager(config, root), config);
  await attachment.ready;
  return { attachment, shutdown: mcp.shutdown };
}

Deno.test("general sub-agents discover and call the session's MCP tools", async () => {
  const { faux, hub, root } = makeScriptedHub();
  const { attachment, shutdown } = await makePingAttachment(root);
  const registry = new ToolRegistry();
  registry.setTools(attachment.getTools());
  hub.setMcp(attachment, registry);
  try {
    // The sub-agent is the only consumer of the scripted responses, so the
    // turn sequence is deterministic: search for the MCP tool, call it
    // through tool_call, then assert the pong reached the transcript and
    // report. The MCP definitions are never part of the tool set — only the
    // search/call pair is.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "ping" }),
      ]),
      fauxAssistantMessage([
        fauxText("Calling MCP."),
        fauxToolCall(TOOL_CALL, { name: "mcp__remote__ping", args: {} }),
      ]),
      (context) => {
        const text = JSON.stringify(context);
        assert(
          text.includes("pong (session ok)"),
          `MCP result missing from the sub-agent transcript: ${text}`,
        );
        return fauxAssistantMessage("MCP worked.");
      },
    ]);
    hub.spawn(
      "session-1",
      0,
      "general",
      "MCP呼び出し",
      "Find and call the MCP ping tool, then report the result",
    );
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list()[0]!.text, "MCP worked.");
  } finally {
    hub.close();
    shutdown();
  }
});

Deno.test("general sub-agents do not preload browser tools — only the pair is attached", async () => {
  const { faux, hub } = makeScriptedHub();
  const registry = new ToolRegistry();
  registry.addTools(createBrowserTools(new FakeBrowserBackend()));
  hub.setMcp(null, registry);
  try {
    // The model calls browser_open directly, bypassing tool_search: like
    // MCP definitions, the browser tools are never part of the sub-agent's
    // tool set, so the call fails as unknown.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Trying browser."),
        fauxToolCall(TOOL_BROWSER_OPEN, { url: "http://127.0.0.1:5173/" }),
      ]),
      (context) => {
        const text = JSON.stringify(context);
        assert(
          text.includes("Tool browser_open not found"),
          `the direct call should have failed: ${text}`,
        );
        assert(
          !text.includes("Opened http://"),
          `the browser must not have been opened: ${text}`,
        );
        return fauxAssistantMessage("No browser here.");
      },
    ]);
    hub.spawn(
      "session-1",
      0,
      "general",
      "ブラウザ調査",
      "Try to open the app in the browser",
    );
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list()[0]!.text, "No browser here.");
  } finally {
    hub.close();
  }
});

Deno.test("general sub-agents discover and call the session's browser tools", async () => {
  const { faux, hub } = makeScriptedHub();
  const backend = new FakeBrowserBackend();
  const registry = new ToolRegistry();
  registry.addTools(createBrowserTools(backend));
  hub.setMcp(null, registry);
  try {
    // The browser tools are found through tool_search and executed via
    // tool_call, exactly like MCP tools — nothing is preloaded.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "browser_open" }),
      ]),
      fauxAssistantMessage([
        fauxText("Opening."),
        fauxToolCall(TOOL_CALL, {
          name: TOOL_BROWSER_OPEN,
          args: { url: "http://127.0.0.1:5173/" },
        }),
      ]),
      (context) => {
        const text = JSON.stringify(context);
        assert(
          text.includes("Opened http://127.0.0.1:5173/"),
          `open result missing from the sub-agent transcript: ${text}`,
        );
        return fauxAssistantMessage("Browser worked.");
      },
    ]);
    hub.spawn(
      "session-1",
      0,
      "general",
      "ブラウザ操作",
      "Find and use the browser open tool, then report the result",
    );
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list()[0]!.text, "Browser worked.");
    assertEquals(backend.opens.length, 1);
    assertEquals(backend.opens[0]!.url, "http://127.0.0.1:5173/");
  } finally {
    hub.close();
  }
});

Deno.test("explore sub-agents have no MCP tools", async () => {
  const { faux, hub, root } = makeScriptedHub();
  const { attachment, shutdown } = await makePingAttachment(root);
  const registry = new ToolRegistry();
  registry.setTools(attachment.getTools());
  hub.setMcp(attachment, registry);
  try {
    // Explore sub-agents get neither the MCP tools nor the search/call
    // pair, so a tool_call attempt fails as an unknown tool.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Trying MCP."),
        fauxToolCall(TOOL_CALL, { name: "mcp__remote__ping", args: {} }),
      ]),
      (context) => {
        const text = JSON.stringify(context);
        assert(
          text.includes("Tool tool_call not found"),
          `the call should have failed: ${text}`,
        );
        assert(
          !text.includes("pong"),
          `the MCP tool must not have executed: ${text}`,
        );
        return fauxAssistantMessage("No MCP here.");
      },
    ]);
    hub.spawn(
      "session-1",
      0,
      "explore",
      "MCP調査",
      "Try to call the mcp__remote__ping tool",
    );
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list()[0]!.text, "No MCP here.");
  } finally {
    hub.close();
    shutdown();
  }
});

Deno.test("a config change redirects a running general sub-agent to the new registry", async () => {
  const { faux, hub, root } = makeScriptedHub();
  const first = await makePingAttachment(root, "remote");
  const firstRegistry = new ToolRegistry();
  firstRegistry.setTools(first.attachment.getTools());
  hub.setMcp(first.attachment, firstRegistry);
  const second = await makePingAttachment(root, "remote2");
  const secondRegistry = new ToolRegistry();
  secondRegistry.setTools(second.attachment.getTools());
  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Searching."),
        fauxToolCall(TOOL_SEARCH, { query: "ping" }),
      ]),
      fauxAssistantMessage([
        fauxText("Calling MCP."),
        fauxToolCall(TOOL_CALL, { name: "mcp__remote2__ping", args: {} }),
      ]),
      (context) => {
        const text = JSON.stringify(context);
        assert(
          text.includes("mcp__remote2__ping"),
          `the search must see the new config's tools: ${text}`,
        );
        assert(
          !text.includes("mcp__remote__ping"),
          `the old config's tools must be gone: ${text}`,
        );
        assert(
          text.includes("pong (session ok)"),
          `MCP result missing from the sub-agent transcript: ${text}`,
        );
        return fauxAssistantMessage("MCP worked.");
      },
    ]);
    hub.spawn(
      "session-1",
      0,
      "general",
      "MCP呼び出し",
      "Find and call the MCP ping tool, then report the result",
    );
    // Config change while the sub-agent runs: the pool rebuilds the
    // session's registry. The pair attached at spawn must redirect to the
    // new registry without being replaced.
    hub.setMcp(second.attachment, secondRegistry);
    await waitFor(() => hub.list()[0]!.status === "finished", "task finish");
    assertEquals(hub.list()[0]!.text, "MCP worked.");
  } finally {
    hub.close();
    first.shutdown();
    second.shutdown();
  }
});

Deno.test("a stale attachment's discovery cannot overwrite the current registry", async () => {
  const { hub, root } = makeScriptedHub();
  const slow = startPingMcpServer(400);
  const fast = startPingMcpServer(0);
  const configFor = (port: number, serverName: string) =>
    parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          [serverName]: { url: `http://127.0.0.1:${port}/mcp` },
        },
      }),
      join(root, ".mcp.json"),
    );
  // The first attachment's discovery is still in flight when a config
  // change replaces it — the pool's open() does the same on every rebuild.
  const first = new McpAttachment(
    new McpManager(configFor(slow.port, "remote"), root),
    configFor(slow.port, "remote"),
  );
  const firstRegistry = new ToolRegistry();
  hub.setMcp(first, firstRegistry);
  const second = new McpAttachment(
    new McpManager(configFor(fast.port, "remote2"), root),
    configFor(fast.port, "remote2"),
  );
  const secondRegistry = new ToolRegistry();
  hub.setMcp(second, secondRegistry);

  // The new config's discovery lands first, the stale one later — the
  // stale callback must be ignored.
  await second.ready;
  await first.ready;
  assertEquals(secondRegistry.count, 1);
  assertEquals(secondRegistry.get("mcp__remote2__ping") !== undefined, true);
  assertEquals(firstRegistry.count, 0, "stale tools must not be applied");
  hub.close();
  slow.shutdown();
  fast.shutdown();
});
