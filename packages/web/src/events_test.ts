import { assertEquals } from "@std/assert";
import {
  applyEvent,
  filterRemoved,
  mergeBackgrounds,
  mergeMessages,
  mergeTasks,
  sameBackgrounds,
  sameTodoPlan,
} from "./events.ts";
import {
  type AgentMessage,
  type BackgroundCommandInfo,
  type BackgroundView,
  isViewRunning,
  type SessionView,
  type TaskInfo,
  type TaskView,
  type TodoPhase,
} from "./types.ts";

function message(
  role: AgentMessage["role"],
  timestamp: number,
  text = "hello",
): AgentMessage {
  return { role, timestamp, content: [{ type: "text", text }] } as AgentMessage;
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    info: {
      id: "s1",
      workspaceId: "w1",
      name: "s",
      modelProvider: "p",
      modelId: "m",
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [],
    streamingText: "",
    runningTools: new Map(),
    pendingQuestions: [],
    todos: [],
    tasks: [],
    backgrounds: [],
    removed: new Set(),
    ...overrides,
  };
}

Deno.test("events: user message is appended on start, replaced on end", () => {
  let v = view();
  v = applyEvent(
    {
      type: "message_start",
      sessionId: "s1",
      message: message("user", 100),
    },
    v,
  )!;
  assertEquals(v.messages.length, 1);

  // Same timestamp, final copy: replace, not append.
  v = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: message("user", 100, "final"),
    },
    v,
  )!;
  assertEquals(v.messages.length, 1);
  const finalMessage = v.messages[0] as { content: Array<{ text: string }> };
  assertEquals(finalMessage.content[0]!.text, "final");

  // End without a preceding start: append.
  const v2 = applyEvent(
    { type: "message_end", sessionId: "s1", message: message("user", 200) },
    view(),
  )!;
  assertEquals(v2.messages.length, 1);
});

Deno.test("events: assistant message_end never duplicates after a resync", () => {
  // The resync fetch already contains the message; the late message_end
  // event must not append a second copy.
  const existing = view({ messages: [message("assistant", 100, "done")] });
  const v = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: message("assistant", 100, "done"),
    },
    existing,
  )!;
  assertEquals(v.messages.length, 1);
  assertEquals(v.streamingText, "");
});

Deno.test("events: user message_start never duplicates (steered while running)", () => {
  // A message sent while the agent runs is announced immediately by the
  // server and re-emitted when the running loop drains it; the second
  // emission has the same role + timestamp and must not append a copy.
  const m = message("user", 100, "stop");
  let v = view();
  v = applyEvent({ type: "message_start", sessionId: "s1", message: m }, v)!;
  assertEquals(v.messages.length, 1);
  v = applyEvent({ type: "message_start", sessionId: "s1", message: m }, v)!;
  assertEquals(v.messages.length, 1);
  v = applyEvent({ type: "message_end", sessionId: "s1", message: m }, v)!;
  assertEquals(v.messages.length, 1);
});

Deno.test("events: assistant stream accumulates deltas and clears on start", () => {
  let v = view();
  v = applyEvent(
    {
      type: "message_start",
      sessionId: "s1",
      message: message("assistant", 100),
    },
    v,
  )!;
  v = applyEvent(
    { type: "message_delta", sessionId: "s1", delta: "Hel" },
    v,
  )!;
  v = applyEvent(
    { type: "message_delta", sessionId: "s1", delta: "lo" },
    v,
  )!;
  assertEquals(v.streamingText, "Hello");
  v = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: message("assistant", 100),
    },
    v,
  )!;
  assertEquals(v.streamingText, "");
});

Deno.test("events: tool start/end track running tools", () => {
  let v = view();
  v = applyEvent(
    {
      type: "tool_start",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    },
    v,
  )!;
  assertEquals(v.runningTools.get("t1"), "bash");
  v = applyEvent(
    {
      type: "tool_end",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "bash",
      result: {},
      isError: false,
    },
    v,
  )!;
  assertEquals(v.runningTools.size, 0);
});

Deno.test("events: errors are set on session_error and cleared on agent_start", () => {
  let v = view();
  v = applyEvent(
    { type: "session_error", sessionId: "s1", message: "boom" },
    v,
  )!;
  assertEquals(v.error, "boom");
  v = applyEvent({ type: "agent_start", sessionId: "s1" }, v)!;
  assertEquals(v.error, undefined);
  assertEquals(isViewRunning(v), true);
  v = applyEvent({ type: "agent_end", sessionId: "s1" }, v)!;
  assertEquals(isViewRunning(v), false);
});

Deno.test("events: other sessions and non-view events are ignored", () => {
  const v = view();
  assertEquals(
    applyEvent({ type: "message_delta", sessionId: "other", delta: "x" }, v),
    null,
  );
  assertEquals(
    applyEvent(
      {
        type: "session_created",
        session: v.info,
      },
      v,
    ),
    null,
  );
  // No-op events return the same view reference.
  assertEquals(
    applyEvent({ type: "agent_end", sessionId: "s1" }, v),
    null,
  );
});

Deno.test("events: mergeMessages is idempotent and order-preserving", () => {
  const existing = [message("user", 100), message("assistant", 200)];
  const fetched = [
    message("user", 100),
    message("assistant", 200),
    message("assistant", 300),
  ];
  const merged = mergeMessages(existing, fetched);
  assertEquals(merged.length, 3);
  assertEquals(merged[2]!.timestamp, 300);
  // Running the merge again with the same inputs must not grow the list.
  assertEquals(mergeMessages(merged, fetched).length, 3);
});

Deno.test("events: messages_truncated drops the exact removed messages", () => {
  let v = view({
    messages: [
      message("user", 100),
      message("assistant", 100), // same millisecond as the boundary: kept
      message("user", 300),
      message("assistant", 400),
    ],
    streamingText: "partial",
    runningTools: new Map([["t1", "bash"]]),
    error: "boom",
    agentStartedAt: 1,
    agentEndedAt: undefined,
    thinkingStartAt: 2,
  });

  v = applyEvent(
    {
      type: "messages_truncated",
      sessionId: "s1",
      removed: [
        { role: "user", timestamp: 300 },
        { role: "assistant", timestamp: 400 },
      ],
    },
    v,
  )!;

  // Exactly the removed messages are gone — a message sharing the
  // boundary's millisecond is kept.
  assertEquals(
    v.messages.map((m) => `${m.role}:${m.timestamp}`),
    ["user:100", "assistant:100"],
  );
  // Run state is cleared (a running run was aborted).
  assertEquals(v.streamingText, "");
  assertEquals(v.runningTools.size, 0);
  assertEquals(v.error, undefined);
  assertEquals(v.agentStartedAt, undefined);
  assertEquals(v.agentEndedAt, undefined);
  assertEquals(v.thinkingStartAt, undefined);
  // The removed keys are tombstoned for the append-only resync.
  assertEquals(
    [...v.removed].sort(),
    ["user:300", "assistant:400"].sort(),
  );

  // Other sessions are ignored.
  assertEquals(
    applyEvent(
      {
        type: "messages_truncated",
        sessionId: "s2",
        removed: [{ role: "user", timestamp: 100 }],
      },
      view({ messages: [message("user", 100)] }),
    ),
    null,
  );
});

Deno.test("events: filterRemoved drops tombstoned messages from a resync", () => {
  const fetched = [
    message("user", 100),
    message("assistant", 200),
    message("user", 300),
  ];
  const removed = new Set(["user:300"]);
  const filtered = filterRemoved(fetched, removed);
  assertEquals(
    filtered.map((m) => m.timestamp),
    [100, 200],
  );
  // An empty tombstone set is a no-op (same reference).
  assertEquals(filterRemoved(fetched, new Set()), fetched);
});

Deno.test("events: session_renamed updates the session name", () => {
  let v = view();
  v = applyEvent(
    { type: "session_renamed", sessionId: "s1", name: "Fix login bug" },
    v,
  )!;
  assertEquals(v.info.name, "Fix login bug");

  // Same name: no-op (same reference).
  assertEquals(
    applyEvent({
      type: "session_renamed",
      sessionId: "s1",
      name: "Fix login bug",
    }, v),
    null,
  );

  // Other sessions are ignored.
  assertEquals(
    applyEvent({ type: "session_renamed", sessionId: "s2", name: "x" }, v),
    null,
  );
});

const QUESTION = {
  id: "q1",
  question: "Which language?",
  options: [{ label: "Deno" }, { label: "Node" }],
};

Deno.test("events: question is shown and cleared by tool_end", () => {
  let v = view();
  v = applyEvent(
    {
      type: "question",
      sessionId: "s1",
      toolCallId: "t1",
      questions: [QUESTION],
    },
    v,
  )!;
  assertEquals(v.pendingQuestions.length, 1);
  assertEquals(v.pendingQuestions[0]!.toolCallId, "t1");

  // A re-delivered event (resync) must not duplicate the panel.
  v = applyEvent(
    {
      type: "question",
      sessionId: "s1",
      toolCallId: "t1",
      questions: [QUESTION],
    },
    v,
  )!;
  assertEquals(v.pendingQuestions.length, 1);

  // The tool call resolved: the panel is gone.
  v = applyEvent(
    {
      type: "tool_end",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "ask",
      result: {},
      isError: false,
    },
    v,
  )!;
  assertEquals(v.pendingQuestions.length, 0);
});

const TODOS: TodoPhase[] = [{
  id: "p1",
  name: "実装",
  tasks: [
    { id: "t1", name: "調査する", status: "completed" },
    { id: "t2", name: "実装する", status: "in_progress" },
    { id: "t3", name: "テストする", status: "pending" },
  ],
}];

Deno.test("events: todo snapshot replaces the plan", () => {
  let v = view();
  v = applyEvent({ type: "todo", sessionId: "s1", todos: TODOS }, v)!;
  assertEquals(v.todos, TODOS);

  // A re-delivered event (resync) converges to the same snapshot.
  v = applyEvent({ type: "todo", sessionId: "s1", todos: TODOS }, v)!;
  assertEquals(v.todos, TODOS);

  // Another session's todo events do not touch this view.
  assertEquals(
    applyEvent({ type: "todo", sessionId: "s2", todos: [] }, v),
    null,
  );
});

Deno.test("events: sameTodoPlan compares snapshots exactly", () => {
  assertEquals(sameTodoPlan([], []), true);
  assertEquals(sameTodoPlan(TODOS, structuredClone(TODOS)), true);
  // Any difference in ids, names, order, or statuses is detected.
  const statusChanged = structuredClone(TODOS);
  statusChanged[0]!.tasks[2]!.status = "blocked";
  assertEquals(sameTodoPlan(TODOS, statusChanged), false);
  const reordered = structuredClone(TODOS);
  reordered[0]!.tasks.reverse();
  assertEquals(sameTodoPlan(TODOS, reordered), false);
  const renamed = structuredClone(TODOS);
  renamed[0]!.name = "別フェーズ";
  assertEquals(sameTodoPlan(TODOS, renamed), false);
  assertEquals(sameTodoPlan(TODOS, []), false);
});

Deno.test("events: two pending asks coexist and resolve independently", () => {
  let v = view();
  v = applyEvent(
    {
      type: "question",
      sessionId: "s1",
      toolCallId: "t1",
      questions: [QUESTION],
    },
    v,
  )!;
  v = applyEvent(
    {
      type: "question",
      sessionId: "s1",
      toolCallId: "t2",
      questions: [{ ...QUESTION, id: "q2" }],
    },
    v,
  )!;
  assertEquals(v.pendingQuestions.length, 2);

  v = applyEvent(
    {
      type: "tool_end",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "ask",
      result: {},
      isError: false,
    },
    v,
  )!;
  assertEquals(v.pendingQuestions.map((q) => q.toolCallId), ["t2"]);
});

Deno.test("events: pending questions are cleared on run teardown", () => {
  // agent_end (abort or completion) clears the panels.
  let v = view({
    pendingQuestions: [{ toolCallId: "t1", questions: [QUESTION] }],
    agentStartedAt: 1,
  });
  v = applyEvent({ type: "agent_end", sessionId: "s1" }, v)!;
  assertEquals(v.pendingQuestions.length, 0);

  // agent_start (new run) clears stale panels from a previous run.
  v = view({ pendingQuestions: [{ toolCallId: "t1", questions: [QUESTION] }] });
  v = applyEvent({ type: "agent_start", sessionId: "s1" }, v)!;
  assertEquals(v.pendingQuestions.length, 0);

  // messages_truncated (rewind aborted the run) clears them too.
  v = view({ pendingQuestions: [{ toolCallId: "t1", questions: [QUESTION] }] });
  v = applyEvent(
    {
      type: "messages_truncated",
      sessionId: "s1",
      removed: [{ role: "user", timestamp: 100 }],
    },
    v,
  )!;
  assertEquals(v.pendingQuestions.length, 0);
});

// --- task events (the task tool) ----------------------------------------------

Deno.test("events: task events add, feed, and settle tasks", () => {
  let v = view();
  const start = {
    type: "task_start" as const,
    sessionId: "s1",
    agentId: "agent_1",
    parentAgentId: "s1",
    subagentType: "general" as const,
    description: "調査",
  };
  v = applyEvent(start, v)!;
  assertEquals(v.tasks.length, 1);
  assertEquals(v.tasks[0]!.status, "running");

  // A re-delivered task_start (resync race) must not duplicate the task.
  v = applyEvent(start, v)!;
  assertEquals(v.tasks.length, 1);

  v = applyEvent(
    {
      type: "task_delta",
      sessionId: "s1",
      agentId: "agent_1",
      delta: "hello ",
    },
    v,
  )!;
  v = applyEvent(
    { type: "task_delta", sessionId: "s1", agentId: "agent_1", delta: "world" },
    v,
  )!;
  assertEquals(v.tasks[0]!.liveText, "hello world");

  // Deltas of another agent do not touch this task.
  v = applyEvent(
    { type: "task_delta", sessionId: "s1", agentId: "agent_9", delta: "x" },
    v,
  )!;
  assertEquals(v.tasks[0]!.liveText, "hello world");

  v = applyEvent(
    {
      type: "task_end",
      sessionId: "s1",
      agentId: "agent_1",
      status: "finished",
    },
    v,
  )!;
  assertEquals(v.tasks[0]!.status, "finished");
});

Deno.test("events: mergeTasks merges snapshots without losing live deltas", () => {
  const existing: TaskView[] = [{
    agentId: "agent_1",
    subagentType: "general",
    description: "調査",
    status: "running",
    liveText: "a longer live response",
  }];
  const fetched: TaskInfo[] = [
    {
      agentId: "agent_1",
      parentAgentId: "s1",
      subagentType: "general",
      description: "調査",
      status: "finished",
      startedAt: 1,
      text: "final",
    },
    {
      agentId: "agent_2",
      parentAgentId: "s1",
      subagentType: "explore",
      description: "深掘り",
      status: "running",
      startedAt: 2,
      text: "tail",
    },
  ];
  const merged = mergeTasks(existing, fetched);
  assertEquals(merged.length, 2);
  // Known task: status from the snapshot; the longer view text wins over
  // the point-in-time snapshot text.
  assertEquals(merged[0]!.status, "finished");
  assertEquals(merged[0]!.liveText, "a longer live response");
  // Unknown task: appended from the snapshot.
  assertEquals(merged[1]!.agentId, "agent_2");
  assertEquals(merged[1]!.liveText, "tail");
});

// --- background events (the async_bash tool) ---------------------------------

const START = {
  type: "background_start" as const,
  sessionId: "s1",
  commandId: "1",
  pid: 1234,
  command: "npm run dev",
  cwd: "/ws",
  startedAt: 100,
};

Deno.test("events: background events add, feed, and settle commands", () => {
  let v = view();
  v = applyEvent(START, v)!;
  assertEquals(v.backgrounds.length, 1);
  assertEquals(v.backgrounds[0]!.state, "running");
  assertEquals(v.backgrounds[0]!.command, "npm run dev");

  // A re-delivered background_start (resync race) must not duplicate it.
  v = applyEvent(START, v)!;
  assertEquals(v.backgrounds.length, 1);

  v = applyEvent(
    {
      type: "background_delta",
      sessionId: "s1",
      commandId: "1",
      delta: "listen ",
    },
    v,
  )!;
  v = applyEvent(
    { type: "background_delta", sessionId: "s1", commandId: "1", delta: "ing" },
    v,
  )!;
  assertEquals(v.backgrounds[0]!.liveText, "listen ing");

  // Deltas of another command do not touch this one.
  v = applyEvent(
    { type: "background_delta", sessionId: "s1", commandId: "9", delta: "x" },
    v,
  )!;
  assertEquals(v.backgrounds[0]!.liveText, "listen ing");

  v = applyEvent(
    {
      type: "background_end",
      sessionId: "s1",
      commandId: "1",
      state: "finished",
      exitCode: 0,
      finishedAt: 200,
      tail: "listen ing on :3000",
    },
    v,
  )!;
  assertEquals(v.backgrounds[0]!.state, "finished");
  assertEquals(v.backgrounds[0]!.exitCode, 0);
  // The event's tail is the authoritative output: it replaces the shorter
  // accumulated live text.
  assertEquals(v.backgrounds[0]!.liveText, "listen ing on :3000");
  assertEquals(v.backgrounds[0]!.tail, "listen ing on :3000");
});

Deno.test("events: background_end keeps a longer live view", () => {
  // The end event's tail is a point-in-time snapshot: when the live view
  // (deltas) is already longer, it must not be truncated back.
  let v = view({
    backgrounds: [{
      commandId: "1",
      pid: 1,
      command: "echo",
      cwd: "/ws",
      state: "running",
      startedAt: 1,
      tail: "",
      liveText: "a very long live output that exceeds the snapshot",
    }],
  });
  v = applyEvent(
    {
      type: "background_end",
      sessionId: "s1",
      commandId: "1",
      state: "finished",
      exitCode: 0,
      finishedAt: 2,
      tail: "short",
    },
    v,
  )!;
  assertEquals(
    v.backgrounds[0]!.liveText,
    "a very long live output that exceeds the snapshot",
  );
  assertEquals(v.backgrounds[0]!.tail, "short");
});

Deno.test("events: mergeBackgrounds merges snapshots without losing live deltas", () => {
  const existing: BackgroundView[] = [{
    commandId: "1",
    pid: 1,
    command: "npm run dev",
    cwd: "/ws",
    state: "running",
    startedAt: 1,
    tail: "",
    liveText: "a longer live output",
  }];
  const fetched: BackgroundCommandInfo[] = [
    {
      commandId: "1",
      pid: 1,
      command: "npm run dev",
      cwd: "/ws",
      state: "finished",
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
      tail: "final",
    },
    {
      commandId: "2",
      pid: 2,
      command: "sleep 60",
      cwd: "/ws",
      state: "running",
      startedAt: 3,
      tail: "",
    },
  ];
  const merged = mergeBackgrounds(existing, fetched);
  assertEquals(merged.length, 2);
  // Known command: state from the snapshot; the longer view text wins over
  // the point-in-time snapshot tail.
  assertEquals(merged[0]!.state, "finished");
  assertEquals(merged[0]!.liveText, "a longer live output");
  // Unknown command: appended from the snapshot, seeded with its tail.
  assertEquals(merged[1]!.commandId, "2");
  assertEquals(merged[1]!.state, "running");
  assertEquals(merged[1]!.liveText, "");
});

Deno.test("events: sameBackgrounds compares snapshots exactly", () => {
  const list: BackgroundView[] = [{
    commandId: "1",
    pid: 1,
    command: "npm run dev",
    cwd: "/ws",
    state: "running",
    startedAt: 1,
    tail: "",
    liveText: "x",
  }];
  assertEquals(sameBackgrounds([], []), true);
  assertEquals(sameBackgrounds(list, structuredClone(list)), true);
  // A state change is detected (live text is deliberately not compared).
  const stateChanged = structuredClone(list);
  stateChanged[0]!.state = "finished";
  assertEquals(sameBackgrounds(list, stateChanged), false);
  const textChanged = structuredClone(list);
  textChanged[0]!.liveText = "y";
  assertEquals(sameBackgrounds(list, textChanged), true);
  assertEquals(sameBackgrounds(list, []), false);
});
