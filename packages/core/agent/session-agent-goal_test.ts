import { assertEquals } from "@std/assert";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { AskHub } from "../tools/ask.ts";
import type { ClientEvent } from "../types/event.ts";
import type { GoalInfo } from "../shared/goal.ts";
import { SessionAgent } from "./session-agent.ts";

function fakeModel(): Model<Api> {
  return { id: "test", name: "test" } as unknown as Model<Api>;
}

interface GoalStoreState {
  goal: GoalInfo | undefined;
}

function memoryGoalStore(state: GoalStoreState) {
  return {
    loadGoal: () => state.goal,
    saveGoal: (text: string, maxIterations: number) => {
      state.goal = { text, iteration: 0, maxIterations, status: "active" };
      return state.goal;
    },
    updateGoal: (patch: {
      iteration?: number;
      status?: GoalInfo["status"];
      lastReason?: string | null;
    }) => {
      if (!state.goal) return undefined;
      state.goal = {
        ...state.goal,
        ...(patch.iteration !== undefined
          ? { iteration: patch.iteration }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.lastReason !== undefined
          ? (patch.lastReason === null ? {} : { lastReason: patch.lastReason })
          : {}),
      };
      return state.goal;
    },
    clearGoal: () => {
      const text = state.goal?.text;
      state.goal = undefined;
      return text;
    },
  };
}

/** Mixed streamFn: main-agent calls get full messages, goal-judge calls get
 * text_delta JSON (distinguished by the judge system prompt). */
function mixedStream(
  mainResponses: string[],
  judgeReplies: string[],
): StreamFn {
  return ((_model, request: { systemPrompt?: string }) => {
    const systemPrompt = request?.systemPrompt ?? "";
    if (systemPrompt.includes("goal judge")) {
      const text = judgeReplies.shift() ?? "";
      const events = (async function* () {
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: fauxAssistantMessage(""),
        };
      })();
      return events as unknown as AssistantMessageEventStream;
    }
    const text = mainResponses.shift() ?? "done";
    const stream = createAssistantMessageEventStream();
    const message = fauxAssistantMessage(text);
    stream.push({ type: "start", partial: message });
    stream.end(message);
    return stream;
  }) as unknown as StreamFn;
}

function makeGoalAgent(
  streamFn: StreamFn,
  state: GoalStoreState,
  events: ClientEvent[],
): SessionAgent {
  return new SessionAgent({
    sessionId: "s1",
    systemPrompt: "You are a test agent.",
    model: fakeModel(),
    tools: [],
    streamFn,
    messageRepo: {
      append: (_sessionId, message) => ({
        id: "id",
        sessionId: _sessionId,
        role: message.role,
        message,
        timestamp: message.timestamp,
      }),
      list: () => [],
      listMessages: () => [],
      deleteFrom: () => {},
      deleteBySession: () => {},
    },
    onEvent: (event) => {
      events.push(event);
    },
    askHub: new AskHub("s1", () => {}),
    renameSession: () => {},
    fastModel: fakeModel(),
    goalStore: memoryGoalStore(state),
  });
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("goal mode prompt starts the goal and the loop finishes it", async () => {
  const state: GoalStoreState = { goal: undefined };
  const events: ClientEvent[] = [];
  const agent = makeGoalAgent(
    mixedStream(["work done"], ['{"achieved": true, "reason": "all green"}']),
    state,
    events,
  );
  agent.promptWhileRunning("full prompt", undefined, {
    modeId: "goal",
    optionId: "",
    modeLabel: "ゴールモード",
    shortText: "全テストを通す",
  });
  await waitFor(() =>
    state.goal === undefined && events.some((e) => e.type === "goal_done")
  );
  assertEquals(
    events.some((e) => e.type === "goal_start"),
    true,
  );
  const done = events.find((e) => e.type === "goal_done") as {
    achieved: boolean;
  };
  assertEquals(done.achieved, true);
  await agent.waitForIdle();
});

Deno.test("cancelGoal clears the goal with a cancel event", () => {
  const state: GoalStoreState = {
    goal: { text: "g", iteration: 0, maxIterations: 10, status: "active" },
  };
  const events: ClientEvent[] = [];
  const agent = makeGoalAgent(mixedStream([], []), state, events);
  agent.cancelGoal();
  assertEquals(state.goal, undefined);
  const done = events.find((e) => e.type === "goal_done") as {
    achieved: boolean;
    reason: string;
  };
  assertEquals(done.achieved, false);
  assertEquals(done.reason.includes("中断"), true);
});

Deno.test("abort clears an active goal", () => {
  const state: GoalStoreState = {
    goal: { text: "g", iteration: 0, maxIterations: 10, status: "active" },
  };
  const events: ClientEvent[] = [];
  const agent = makeGoalAgent(mixedStream([], []), state, events);
  agent.abort();
  assertEquals(state.goal, undefined);
  assertEquals(events.some((e) => e.type === "goal_done"), true);
});

Deno.test("rewinding the goal declaration cancels the goal", async () => {
  const state: GoalStoreState = {
    goal: { text: "g", iteration: 0, maxIterations: 10, status: "active" },
  };
  const events: ClientEvent[] = [];
  const agent = makeGoalAgent(mixedStream(["done"], []), state, events);
  // Seed a goal mode message + a later turn, then rewind the declaration.
  const goalTimestamp = 1000;
  (agent.messages as AgentMessage[]).push({
    role: "mode",
    modeId: "goal",
    optionId: "",
    modeLabel: "ゴールモード",
    shortText: "g",
    fullPrompt: "full",
    timestamp: goalTimestamp,
  } as unknown as AgentMessage);
  (agent.messages as AgentMessage[]).push({
    role: "assistant",
    content: [{ type: "text", text: "work" }],
    timestamp: 2000,
  } as unknown as AgentMessage);
  await agent.rewind(goalTimestamp);
  assertEquals(state.goal, undefined);
  assertEquals(events.some((e) => e.type === "goal_done"), true);
});
