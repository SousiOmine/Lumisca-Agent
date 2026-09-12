import { assertEquals, assertThrows } from "@std/assert";
import type { TodoPhase } from "../shared/mod.ts";
import type { ClientEvent } from "../types/event.ts";
import { createTodoTool, formatTodoCounts, TodoHub } from "./todo.ts";
import { toolText } from "../test-utils.ts";

/** A hub whose emitted events are recorded, so tests can observe the
 * `todo` snapshot events. */
function makeHub() {
  const events: ClientEvent[] = [];
  const hub = new TodoHub("session-1", (event) => events.push(event));
  return { hub, events };
}

/** The tool call id the tests execute with. */
const TOOL_CALL_ID = "call-1";

/** The todo payload of the last `todo` event emitted so far. */
function lastTodo(events: ClientEvent[]): TodoPhase[] {
  const event = events
    .filter((e): e is Extract<ClientEvent, { type: "todo" }> =>
      e.type === "todo"
    )
    .at(-1);
  if (event === undefined) throw new Error("expected a todo event");
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

Deno.test("todo sets the whole plan, defaults statuses, and emits a snapshot", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  const result = await run(tool, {
    phases: [
      {
        name: "実装",
        tasks: [{ name: "調査する" }, {
          name: "実装する",
          status: "in_progress",
        }],
      },
    ],
  });

  const todos = lastTodo(events);
  assertEquals(todos.length, 1);
  assertEquals(todos[0]!.name, "実装");
  assertEquals(todos[0]!.tasks.map((t) => t.name), ["調査する", "実装する"]);
  assertEquals(todos[0]!.tasks.map((t) => t.status), [
    "pending",
    "in_progress",
  ]);
  assertEquals(
    toolText(result),
    "Updated todo list: 1 pending, 1 in progress.",
  );
  assertEquals(result.details, { todos });
});

Deno.test("todo replaces the previous plan on every call", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { phases: [{ name: "A", tasks: [{ name: "a1" }] }] });
  const before = events.length;
  const result = await run(tool, {
    phases: [
      { name: "A", tasks: [{ name: "a1", status: "completed" }] },
      { name: "B", tasks: [{ name: "b1" }] },
    ],
  });

  const todos = lastTodo(events);
  assertEquals(events.length, before + 1, "one snapshot event per call");
  assertEquals(todos.map((p) => p.name), ["A", "B"]);
  assertEquals(statusOf(todos, "t1"), "completed");
  assertEquals(toolText(result), "Updated todo list: 1 pending, 1 completed.");
});

Deno.test("todo keeps ids stable for unchanged phases and tasks", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    phases: [{ name: "A", tasks: [{ name: "a1" }, { name: "a2" }] }],
  });
  const first = hub.getPlan();
  assertEquals(first[0]!.id, "p1");
  assertEquals(first[0]!.tasks.map((t) => t.id), ["t1", "t2"]);

  // The same plan with a new status, plus one added task: existing ids stay.
  await run(tool, {
    phases: [{
      name: "A",
      tasks: [
        { name: "a1", status: "completed" },
        { name: "a2", status: "in_progress" },
        { name: "a3" },
      ],
    }],
  });
  const second = hub.getPlan();
  assertEquals(second[0]!.id, "p1");
  assertEquals(second[0]!.tasks.map((t) => t.id), ["t1", "t2", "t3"]);
  assertEquals(second[0]!.tasks.map((t) => t.status), [
    "completed",
    "in_progress",
    "pending",
  ]);
});

Deno.test("todo ids are never reused after a plan is cleared", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { phases: [{ name: "A", tasks: [{ name: "a1" }] }] });
  await run(tool, { phases: [] });
  await run(tool, { phases: [{ name: "A", tasks: [{ name: "a1" }] }] });
  const todos = hub.getPlan();
  assertEquals(todos[0]!.id, "p2");
  assertEquals(todos[0]!.tasks[0]!.id, "t2");
});

Deno.test("todo carries parallel in_progress tasks", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    phases: [{
      name: "A",
      tasks: [
        { name: "a1", status: "in_progress" },
        { name: "a2", status: "in_progress" },
      ],
    }],
  });
  const todos = hub.getPlan();
  assertEquals(todos[0]!.tasks.map((t) => t.status), [
    "in_progress",
    "in_progress",
  ]);
});

Deno.test("todo clearing the plan reports it and emits an empty snapshot", async () => {
  const { hub, events } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, { phases: [{ name: "A", tasks: [{ name: "a1" }] }] });
  const result = await run(tool, { phases: [] });
  assertEquals(lastTodo(events), []);
  assertEquals(result.details.todos, []);
  assertEquals(toolText(result), "Cleared the todo list.");
});

Deno.test("todo accepts every status and trims names", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  await run(tool, {
    phases: [{
      name: " 実装 ",
      tasks: [
        { name: " a ", status: "completed" },
        { name: " b ", status: "abandoned" },
        { name: " c ", status: "blocked" },
      ],
    }],
  });
  const todos = hub.getPlan();
  assertEquals(todos[0]!.name, "実装");
  assertEquals(todos[0]!.tasks.map((t) => t.name), ["a", "b", "c"]);
  assertEquals(todos[0]!.tasks.map((t) => t.status), [
    "completed",
    "abandoned",
    "blocked",
  ]);
});

Deno.test("todo rejects malformed plans", async () => {
  const { hub } = makeHub();
  const tool = createTodoTool(hub);
  assertThrows(
    () => run(tool, { phases: [{ name: "", tasks: [{ name: "A" }] }] }),
    Error,
    "Phase names must not be empty",
  );
  assertThrows(
    () => run(tool, { phases: [{ name: "A", tasks: [] }] }),
    Error,
    'Phase "A" must have at least one task',
  );
  assertThrows(
    () =>
      run(tool, {
        phases: [
          { name: "A", tasks: [{ name: "同じ" }] },
          { name: "A", tasks: [{ name: "別" }] },
        ],
      }),
    Error,
    "Duplicate phase name: A",
  );
  assertThrows(
    () =>
      run(tool, {
        phases: [{ name: "A", tasks: [{ name: "同じ" }, { name: "同じ" }] }],
      }),
    Error,
    'Duplicate task name in phase "A": 同じ',
  );
  assertThrows(
    () => run(tool, { phases: [{ name: "A", tasks: [{ name: " " }] }] }),
    Error,
    "Task names must not be empty",
  );

  const badStatus = await errorOf(tool, {
    phases: [{ name: "A", tasks: [{ name: "a1", status: "done" }] }],
  });
  assertEquals(
    badStatus?.message,
    "Unknown status: done (expected pending, in_progress, completed, " +
      "abandoned, blocked)",
  );
  // A rejected plan leaves the previous one untouched.
  assertEquals(hub.getPlan(), []);
});

Deno.test("formatTodoCounts reports the statuses in use", () => {
  assertEquals(formatTodoCounts([]), "Cleared the todo list.");
  const phases: TodoPhase[] = [
    {
      id: "p1",
      name: "実装",
      tasks: [
        { id: "t1", name: "a", status: "completed" },
        { id: "t2", name: "b", status: "in_progress" },
        { id: "t3", name: "c", status: "pending" },
        { id: "t4", name: "d", status: "blocked" },
      ],
    },
  ];
  assertEquals(
    formatTodoCounts(phases),
    "Updated todo list: 1 pending, 1 in progress, 1 completed, 1 blocked.",
  );
});
