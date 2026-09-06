import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { ClientEvent } from "../types/event.ts";
import type { GoalInfo } from "../shared/goal.ts";
import { resolveMaxGoalIterations, runGoalLoop } from "./loop.ts";

function fakeModel(): Model<Api> {
  return { id: "fast", name: "fast" } as unknown as Model<Api>;
}

/** A streamFn serving one canned judge reply per call (text_delta). */
function judgeStream(replies: string[]): StreamFn {
  let index = 0;
  return ((_model, _context) => {
    const text = replies[index++] ?? "";
    const events = (async function* () {
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: fauxAssistantMessage(""),
      };
    })();
    return events as unknown as AssistantMessageEventStream;
  }) as StreamFn;
}

interface GoalStore {
  goal: GoalInfo | undefined;
  turns: string[];
  events: ClientEvent[];
  cancelled: boolean;
}

function makeDeps(
  store: GoalStore,
  streamFn: StreamFn,
): Parameters<typeof runGoalLoop>[0] {
  return {
    sessionId: "s1",
    loadGoal: () => store.goal,
    saveGoal: (text: string, maxIterations: number) => {
      store.goal = { text, iteration: 0, maxIterations, status: "active" };
      return store.goal;
    },
    updateGoal: (patch) => {
      if (!store.goal) return undefined;
      store.goal = {
        ...store.goal,
        ...(patch.iteration !== undefined
          ? { iteration: patch.iteration }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.lastReason !== undefined
          ? (patch.lastReason === null ? {} : { lastReason: patch.lastReason })
          : {}),
      };
      return store.goal;
    },
    clearGoal: () => {
      const text = store.goal?.text;
      store.goal = undefined;
      return text;
    },
    getTranscript: (): AgentMessage[] => [
      {
        role: "assistant",
        content: [{ type: "text", text: "did some work" }],
        timestamp: 1,
      } as AgentMessage,
    ],
    getJudgeModel: () => fakeModel(),
    streamFn,
    runTurn: (instruction: string) => {
      store.turns.push(instruction);
      return Promise.resolve();
    },
    emit: (event: ClientEvent) => {
      store.events.push(event);
    },
    isCancelled: () => store.cancelled,
  };
}

Deno.test("goal loop: achieved goal clears and emits done", async () => {
  const store: GoalStore = {
    goal: { text: "goal", iteration: 0, maxIterations: 10, status: "active" },
    turns: [],
    events: [],
    cancelled: false,
  };
  const outcome = await runGoalLoop(
    makeDeps(store, judgeStream(['{"achieved": true, "reason": "all green"}'])),
  );
  assertEquals(outcome.stopped, "achieved");
  assertEquals(store.goal, undefined);
  assertEquals(store.turns.length, 0);
  const done = store.events.find((e) => e.type === "goal_done");
  assertEquals(done !== undefined, true);
  assertEquals((done as { achieved: boolean }).achieved, true);
});

Deno.test("goal loop: unachieved goal injects the next prompt and continues", async () => {
  const store: GoalStore = {
    goal: { text: "goal", iteration: 0, maxIterations: 10, status: "active" },
    turns: [],
    events: [],
    cancelled: false,
  };
  const outcome = await runGoalLoop(
    makeDeps(
      store,
      judgeStream([
        '{"achieved": false, "reason": "test fails", "nextPrompt": "fix it"}',
        '{"achieved": true, "reason": "fixed"}',
      ]),
    ),
  );
  assertEquals(outcome.stopped, "achieved");
  assertEquals(store.turns, ["fix it"]);
  const progress = store.events.filter((e) => e.type === "goal_progress");
  assertEquals(progress.length >= 2, true);
});

Deno.test("goal loop: stops at the iteration cap", async () => {
  const store: GoalStore = {
    goal: { text: "goal", iteration: 2, maxIterations: 2, status: "active" },
    turns: [],
    events: [],
    cancelled: false,
  };
  const outcome = await runGoalLoop(makeDeps(store, judgeStream([])));
  assertEquals(outcome.stopped, "max");
  assertEquals(store.goal, undefined);
  assertEquals(store.turns.length, 0);
});

Deno.test("goal loop: unparseable judge reply stops with an error", async () => {
  const store: GoalStore = {
    goal: { text: "goal", iteration: 0, maxIterations: 10, status: "active" },
    turns: [],
    events: [],
    cancelled: false,
  };
  const outcome = await runGoalLoop(
    makeDeps(store, judgeStream(["not json at all"])),
  );
  assertEquals(outcome.stopped, "error");
  assertEquals(store.goal, undefined);
  assertEquals(
    store.events.some((e) => e.type === "session_error"),
    true,
  );
});

Deno.test("resolveMaxGoalIterations: falls back to the default", () => {
  assertEquals(resolveMaxGoalIterations(5), 5);
  assertEquals(resolveMaxGoalIterations(0) > 0, true);
  assertEquals(resolveMaxGoalIterations(undefined) > 0, true);
});
