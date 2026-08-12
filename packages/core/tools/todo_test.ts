import { assert, assertEquals, assertThrows } from "@std/assert";
import type { TodoPhase } from "../shared.ts";
import type { ClientEvent } from "../types/event.ts";
import { createTodoTool, formatTodo, TodoHub } from "./todo.ts";

/** A hub whose emitted events are recorded, so tests can observe the
 * `todo` snapshot events. */
function makeHub() {
  const events: ClientEvent[] = [];
  const hub = new TodoHub("session-1", (event) => events.push(event));
  return { hub, events };
}

/** The tool call id the tests execute with. */
const TOOL_CALL_ID = "call-1";

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** The todo payload of the last `todo` event emitted so far. */
function lastTodo(events: ClientEvent[]): TodoPhase[] {
  const event = events
    .filter((e): e is Extract<ClientEvent, { type: "todo" }> =>
      e.type === "todo"
    )
    .at(-1);
  assert(event !== undefined, "expected a todo event");
  return event.todos;
}

/** Status of the task with the given id, across the whole plan. */
function statusOf(phases: TodoPhase[], taskId: string): string {
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.id === taskId) return task.status;
    }
  }
  throw new Error(`task not found: ${taskId}`);
}

/** The plan the example uses throughout: one phase 実装 with three tasks. */
function planOf(tasks: string[]): Array<{ name: string; tasks: string[] }> {
  return [{ name: "実装", tasks }];
}

/** Execute one todo tool call and return its result. */
function run(
  tool: ReturnType<typeof createTodoTool>,
  params: Record<string, unknown>,
) {
  return tool.execute(TOOL_CALL_ID, params as never, undefined);
}

/** Run a todo call and capture the error it throws/rejects with (null on
 * success). Catches both sync throws and rejections. */
async function errorOf(
  tool: ReturnType<typeof createTodoTool>,
  params: Record<string, unknown>,
): Promise<{ message: string; kind?: string } | null> {
  try {
    await run(tool, params);
    return null;
  } catch (error) {
    return error as { message: string; kind?: string };
  }
}

Deno.test("todo plan replaces the plan with pending tasks and emits a snapshot", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  const result = await run(tool, {
    action: "plan",
    phases: planOf(["調査する", "実装する", "テストする"]),
  });

  const todos = lastTodo(events);
  assertEquals(todos.length, 1);
  assertEquals(todos[0]!.name, "実装");
  assertEquals(todos[0]!.id, "p1");
  assertEquals(todos[0]!.tasks.map((t) => t.name), [
    "調査する",
    "実装する",
    "テストする",
  ]);
  assertEquals(todos[0]!.tasks.map((t) => t.id), ["t1", "t2", "t3"]);
  assertEquals(todos[0]!.tasks.every((t) => t.status === "pending"), true);
  // The tool result mirrors the plan for the agent.
  assertEquals(toolText(result), formatTodo(todos));
  assertEquals(result.details, { todos });
});

Deno.test("todo plan replaces the previous plan and resets ids", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["一つ目"]) });
  await run(tool, {
    action: "plan",
    phases: [
      { name: "A", tasks: ["a1", "a2"] },
      { name: "B", tasks: ["b1"] },
    ],
  });
  const todos = hub.getPlan();
  assertEquals(todos.map((p) => `${p.id}:${p.name}`), ["p1:A", "p2:B"]);
  assertEquals(todos[0]!.tasks.map((t) => t.id), ["t1", "t2"]);
  assertEquals(todos[1]!.tasks.map((t) => t.id), ["t3"]);
});

Deno.test("todo update changes a status and emits a snapshot", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["調査する", "実装する"]) });
  const result = await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "in_progress",
  });
  assertEquals(statusOf(lastTodo(events), "t1"), "in_progress");
  assertEquals(
    statusOf(result.details.todos as TodoPhase[], "t1"),
    "in_progress",
  );
  assertEquals(toolText(result).includes("[>] 調査する (in_progress)"), true);
});

Deno.test("todo update auto-advances when the current task is completed", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    action: "plan",
    phases: planOf(["調査する", "実装する", "テストする"]),
  });
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "in_progress",
  });

  // 調査完了 → 次の pending の 実装する が in_progress になる
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "completed",
  });
  const afterFirst = hub.getPlan();
  assertEquals(statusOf(afterFirst, "t1"), "completed");
  assertEquals(statusOf(afterFirst, "t2"), "in_progress");
  assertEquals(statusOf(afterFirst, "t3"), "pending");

  // 実装完了 → テストする が in_progress になる
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t2",
    status: "completed",
  });
  const afterSecond = hub.getPlan();
  assertEquals(statusOf(afterSecond, "t2"), "completed");
  assertEquals(statusOf(afterSecond, "t3"), "in_progress");

  // テスト完了 → pending が残っていないので自動進行しない
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t3",
    status: "completed",
  });
  const afterThird = hub.getPlan();
  assertEquals(statusOf(afterThird, "t3"), "completed");
  assertEquals(
    afterThird.flatMap((p) => p.tasks).filter((t) => t.status === "in_progress")
      .length,
    0,
  );
});

Deno.test("todo auto-advance skips non-pending tasks across phases", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    action: "plan",
    phases: [
      { name: "調査", tasks: ["調査する", "設計する"] },
      { name: "実装", tasks: ["実装する"] },
    ],
  });
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "in_progress",
  });
  // 設計を飛ばして(abandoned)調査を完了 → 次は 実装 の 実装する が current
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t2",
    status: "abandoned",
  });
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "completed",
  });
  const todos = hub.getPlan();
  assertEquals(statusOf(todos, "t3"), "in_progress");
});

Deno.test("todo update does not auto-advance when another task is current", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A", "B", "C"]) });
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "in_progress",
  });
  // 現在のタスクでない B を先に完了しても自動進行しない
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t2",
    status: "completed",
  });
  const todos = hub.getPlan();
  assertEquals(statusOf(todos, "t2"), "completed");
  assertEquals(statusOf(todos, "t1"), "in_progress");
  assertEquals(statusOf(todos, "t3"), "pending");
});

Deno.test("todo update advances when completing without a current task", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A", "B", "C"]) });
  // in_progress マークを飛ばして最初のタスクを完了 → 次が current になる
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "completed",
  });
  const todos = hub.getPlan();
  assertEquals(statusOf(todos, "t1"), "completed");
  assertEquals(statusOf(todos, "t2"), "in_progress");
});

Deno.test("todo update keeps at most one in_progress task", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A", "B", "C"]) });
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "in_progress",
  });
  // B を明示的に current にすると A は pending に戻る
  await run(tool, {
    action: "update",
    phase: "p1",
    task: "t2",
    status: "in_progress",
  });
  const todos = hub.getPlan();
  assertEquals(statusOf(todos, "t1"), "pending");
  assertEquals(statusOf(todos, "t2"), "in_progress");
});

Deno.test("todo update by name (phase and task)", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["調査する", "実装する"]) });
  await run(tool, {
    action: "update",
    phase: "実装",
    task: "調査する",
    status: "in_progress",
  });
  // 名前参照で完了 → 自動進行で 実装する が current になる
  await run(tool, {
    action: "update",
    phase: "実装",
    task: "調査する",
    status: "completed",
  });
  const todos = hub.getPlan();
  assertEquals(statusOf(todos, "t1"), "completed");
  assertEquals(statusOf(todos, "t2"), "in_progress");
});

Deno.test("todo update by id works without the phase", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    action: "plan",
    phases: [
      { name: "A", tasks: ["a1", "a2"] },
      { name: "B", tasks: ["b1"] },
    ],
  });
  // タスクidはプラン全体で一意なので、phase なしでも参照できる
  await run(tool, { action: "update", task: "t3", status: "in_progress" });
  const todos = hub.getPlan();
  assertEquals(statusOf(todos, "t3"), "in_progress");
  assertEquals(statusOf(todos, "t1"), "pending");

  // phase なしで存在しないタスク名を参照すると、phase が必要と伝える
  const error = await errorOf(tool, {
    action: "update",
    task: "ないタスク",
    status: "completed",
  });
  assertEquals(
    error?.message,
    "Unknown task: ないタスク (the phase is needed to look up task names)",
  );
});

Deno.test("todo update with a phase never matches tasks of other phases", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    action: "plan",
    phases: [
      { name: "A", tasks: ["a1", "a2"] },
      { name: "B", tasks: ["b1", "b2"] },
    ],
  });
  // t3 は B に所属。phase=A を指定してもその ID は A 内で解決されない。
  const error = await errorOf(tool, {
    action: "update",
    phase: "p1",
    task: "t3",
    status: "completed",
  });
  assertEquals(error?.message, 'Unknown task: t3 (phase "A")');
  assertEquals(statusOf(hub.getPlan(), "t3"), "pending");

  // 正しい phase を指定すれば解決できる。
  await run(tool, {
    action: "update",
    phase: "p2",
    task: "t3",
    status: "completed",
  });
  assertEquals(statusOf(hub.getPlan(), "t3"), "completed");
});

Deno.test("todo update rejects unknown phases and tasks", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A", "B"]) });

  const unknownPhase = await errorOf(tool, {
    action: "update",
    phase: "p9",
    task: "t1",
    status: "completed",
  });
  assertEquals(unknownPhase?.message, "Unknown phase: p9");
  assertEquals(unknownPhase?.kind, "not_found");

  const unknownTask = await errorOf(tool, {
    action: "update",
    phase: "実装",
    task: "t9",
    status: "completed",
  });
  assertEquals(unknownTask?.message, 'Unknown task: t9 (phase "実装")');
  assertEquals(unknownTask?.kind, "not_found");

  const unknownTaskName = await errorOf(tool, {
    action: "update",
    phase: "実装",
    task: "ないタスク",
    status: "completed",
  });
  assertEquals(
    unknownTaskName?.message,
    'Unknown task: ないタスク (phase "実装")',
  );
});

Deno.test("todo update rejects unknown statuses and missing args", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A"]) });

  const badStatus = await errorOf(tool, {
    action: "update",
    phase: "p1",
    task: "t1",
    status: "done",
  });
  assertEquals(
    badStatus?.message,
    "Unknown status: done (expected pending, in_progress, completed, abandoned, blocked)",
  );

  const missing = await errorOf(tool, { action: "update", phase: "p1" });
  assertEquals(missing?.message, "todo update requires `task` and `status`");

  const unknownAction = await errorOf(tool, { action: "nope" });
  assertEquals(
    unknownAction?.message,
    "Unknown action: nope (expected plan, list, update, or clear)",
  );
});

Deno.test("todo clear empties the plan and emits a snapshot", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A", "B"]) });
  const result = await run(tool, { action: "clear" });
  assertEquals(lastTodo(events), []);
  assertEquals(result.details.todos, []);
  assertEquals(toolText(result), "Todo: (empty)");
});

Deno.test("todo list returns the plan without mutating or emitting", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { action: "plan", phases: planOf(["A"]) });
  const before = events.length;
  const result = await run(tool, { action: "list" });
  assertEquals(events.length, before); // list はイベントを出さない
  assertEquals(result.details.todos, hub.getPlan());
});

Deno.test("todo plan rejects empty and duplicate input", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  assertThrows(
    () => run(tool, { action: "plan", phases: [] }),
    Error,
    "todo plan requires at least one phase",
  );
  assertThrows(
    () => run(tool, { action: "plan", phases: [{ name: "", tasks: ["A"] }] }),
    Error,
    "Phase names must not be empty",
  );
  assertThrows(
    () => run(tool, { action: "plan", phases: [{ name: "A", tasks: [] }] }),
    Error,
    'Phase "A" must have at least one task',
  );
  assertThrows(
    () =>
      run(tool, {
        action: "plan",
        phases: [
          { name: "A", tasks: ["同じ"] },
          { name: "A", tasks: ["別"] },
        ],
      }),
    Error,
    "Duplicate phase name: A",
  );
  assertThrows(
    () =>
      run(tool, {
        action: "plan",
        phases: [{ name: "A", tasks: ["同じ", "同じ"] }],
      }),
    Error,
    'Duplicate task name in phase "A": 同じ',
  );
  // 名前はトリムされて保存される
  const result = await run(tool, {
    action: "plan",
    phases: [{ name: " A ", tasks: [" a ", " b "] }],
  });
  const todos = result.details.todos as TodoPhase[];
  assertEquals(todos[0]!.name, "A");
  assertEquals(todos[0]!.tasks.map((t) => t.name), ["a", "b"]);
});

Deno.test("formatTodo renders phases, statuses, and counts", () => {
  assertEquals(formatTodo([]), "Todo: (empty)");
  const phases: TodoPhase[] = [
    {
      id: "p1",
      name: "実装",
      tasks: [
        { id: "t1", name: "調査する", status: "completed" },
        { id: "t2", name: "実装する", status: "in_progress" },
        { id: "t3", name: "テストする", status: "pending" },
      ],
    },
    {
      id: "p2",
      name: "検証",
      tasks: [{ id: "t4", name: "動作確認", status: "blocked" }],
    },
  ];
  assertEquals(
    formatTodo(phases),
    [
      "Todo (2 phases, 4 tasks):",
      "[実装]",
      "  [x] 調査する (completed)",
      "  [>] 実装する (in_progress)",
      "  [ ] テストする (pending)",
      "[検証]",
      "  [!] 動作確認 (blocked)",
    ].join("\n"),
  );
});
