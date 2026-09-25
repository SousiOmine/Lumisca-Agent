import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { fauxAssistantMessage, fauxToolCall } from "@lumisca/core";
import type {
  AgentMessage,
  NotificationKind,
  NotificationMessage,
} from "../../types.ts";
import { applyEvent } from "../../events.ts";
import { emptyView, isViewRunning } from "../../types.ts";
import { buildTurns, ConversationTurn } from "./ConversationTurn.tsx";

function user(timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text: "hi" }], timestamp };
}

function mode(timestamp: number): AgentMessage {
  return {
    role: "mode",
    modeId: "plan",
    optionId: "",
    modeLabel: "プランモード",
    shortText: "履歴機能を追加して",
    fullPrompt: "あなたは実装プランナーです。...",
    timestamp,
  };
}

function notification(
  kind: NotificationKind,
  timestamp: number,
  steered?: boolean,
): NotificationMessage {
  return {
    role: "notification",
    kind,
    title: `[${kind}]`,
    body: "",
    status: "neutral",
    // The session agent stamps `steered` only when the notification joins
    // the run that is already active (see injectNotification); it is absent
    // otherwise.
    ...(steered === true ? { steered } : {}),
    timestamp,
  };
}

function assistant(timestamp: number, text = "hi"): AgentMessage {
  return fauxAssistantMessage(text, { timestamp }) as AgentMessage;
}

Deno.test("buildTurns: user prompts and notifications start a turn", () => {
  // A notification that started its own run (no `steered` stamp) is the
  // prompt of that run, so it begins a turn of its own.
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("background", 3),
    assistant(4),
  ]);
  assertEquals(turns.length, 2);
  assertEquals(turns[0]!.responses.length, 1);
  assertEquals(turns[1]!.responses.length, 1);
});

Deno.test("buildTurns: a steered notification joins the run's turn", () => {
  // A notification injected into the run that is already active is a system
  // event of the ongoing work, like a tool result: it must not split the
  // turn, or the still-running turn's work log would collapse mid-run.
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("task", 3, true),
    assistant(4, "the reaction"),
  ]);
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.user.role, "user");
  assertEquals(
    turns[0]!.responses.map((m) => m.role),
    ["assistant", "notification", "assistant"],
  );
  assertEquals(
    (turns[0]!.responses[1] as NotificationMessage).steered,
    true,
  );
});

Deno.test("buildTurns: a steered notification with no open turn starts one", () => {
  // A leading steered notification has no turn to join: it must still be
  // rendered, so it falls back to starting a turn of its own.
  const turns = buildTurns([
    notification("task", 1, true),
    assistant(2),
  ]);
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.user.role, "notification");
  assertEquals(turns[0]!.responses.map((m) => m.role), ["assistant"]);
});

Deno.test("buildTurns: a steered notification after a checkpoint starts one", () => {
  // A checkpoint turn is standalone (its responses are never rendered), so
  // a steered notification cannot join it: it starts a turn of its own
  // rather than vanishing from the history.
  const checkpoint = (timestamp: number): AgentMessage => ({
    role: "checkpoint",
    title: "履歴 2 件を要約しました（約 12K トークン）",
    body: "summary",
    timestamp,
  });
  const turns = buildTurns([
    user(1),
    assistant(2),
    checkpoint(3),
    notification("task", 4, true),
    assistant(5),
  ]);
  assertEquals(turns.length, 3);
  assertEquals(turns[1]!.standalone, true);
  assertEquals(turns[2]!.user.role, "notification");
  assertEquals(turns[2]!.responses.map((m) => m.role), ["assistant"]);
});

Deno.test("buildTurns: mode messages (slash-command prompts) start a turn", () => {
  // A session started by `/plan 依頼文` has the mode message as its only
  // prompt: it must render as a turn (short text + badge + responses),
  // never vanish from the history.
  const turns = buildTurns([mode(1), assistant(2), assistant(3)]);
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.user.role, "mode");
  assertEquals(turns[0]!.responses.length, 2);

  // A mode message mid-history starts its own turn (like a user prompt).
  const mixed = buildTurns([
    user(1),
    assistant(2),
    mode(3),
    assistant(4),
  ]);
  assertEquals(mixed.length, 2);
  assertEquals(mixed[0]!.user.role, "user");
  assertEquals(mixed[1]!.user.role, "mode");
  assertEquals(mixed[1]!.responses.length, 1);
});

Deno.test("buildTurns: retry notifications do not split the turn", () => {
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("retry", 3),
    assistant(4, "the retried response"),
  ]);
  // One turn: the retry notification neither starts a new turn nor lands
  // in the responses — the retried response joins the same turn.
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.user.role, "user");
  const responses = turns[0]!.responses;
  assertEquals(responses.length, 2);
  assertEquals(responses.every((m) => m.role === "assistant"), true);
});

Deno.test("buildTurns: retry notifications are skipped entirely", () => {
  const turns = buildTurns([
    user(1),
    assistant(2),
    notification("retry", 3),
  ]);
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.responses.length, 1);
});

Deno.test("buildTurns: context snapshots join the turn they precede", () => {
  const context = (timestamp: number): AgentMessage => ({
    role: "context",
    provider: "skills",
    title: "Skills (1 available)",
    body: "<available_skills>\n- demo: A demo skill.\n</available_skills>",
    timestamp,
  });

  // A fresh session publishes its context before the first prompt: the
  // snapshot must render inside that turn, never vanish (it has no turn of
  // its own).
  const leading = buildTurns([
    context(1),
    user(2),
    assistant(3),
  ]);
  assertEquals(leading.length, 1);
  assertEquals(leading[0]!.user.role, "user");
  assertEquals(leading[0]!.responses.map((m) => m.role), [
    "context",
    "assistant",
  ]);

  // A later snapshot lands in the turn that is already open.
  const between = buildTurns([
    user(1),
    assistant(2),
    context(3),
    assistant(4),
  ]);
  assertEquals(between.length, 1);
  assertEquals(between[0]!.responses.map((m) => m.role), [
    "assistant",
    "context",
    "assistant",
  ]);
});

Deno.test("buildTurns: a compaction checkpoint is a turn of its own", () => {
  const checkpoint = (timestamp: number): AgentMessage => ({
    role: "checkpoint",
    title: "履歴 2 件を要約しました（約 12K トークン）",
    body: "summary",
    timestamp,
  });

  // The checkpoint marks where older history was replaced: it must not be
  // absorbed into the surrounding turn, so the retained messages before it
  // stay with their own prompt.
  const turns = buildTurns([
    user(1),
    assistant(2),
    checkpoint(3),
    user(4),
    assistant(5),
  ]);
  assertEquals(turns.length, 3);
  assertEquals(turns[0]!.user.role, "user");
  assertEquals(turns[1]!.user.role, "checkpoint");
  assertEquals(turns[1]!.standalone, true);
  assertEquals(turns[1]!.responses.length, 0);
  assertEquals(turns[2]!.user.role, "user");

  // A checkpoint that replaced the whole prefix is still a row of its own,
  // followed by the retained turn.
  const leading = buildTurns([checkpoint(1), user(2), assistant(3)]);
  assertEquals(leading.length, 2);
  assertEquals(leading[0]!.user.role, "checkpoint");
  assertEquals(leading[0]!.standalone, true);
  assertEquals(leading[1]!.user.role, "user");
});

Deno.test("ConversationTurn: a steered notification renders in the work log", () => {
  // The turn the notification was steered into: the prompt, the work the
  // agent did (a tool call), the notification, then the reaction.
  const responses: AgentMessage[] = [
    fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], {
      timestamp: 2,
    }) as AgentMessage,
    {
      role: "notification",
      kind: "task",
      title: "[Task agent_1 (調査) finished]",
      body: "",
      status: "success",
      steered: true,
      timestamp: 3,
    },
    fauxAssistantMessage("the reaction", { timestamp: 4 }) as AgentMessage,
  ];
  const html = renderToString(createElement(ConversationTurn, {
    turn: { user: user(1), responses },
    toolResults: new Map(),
    runningTools: new Map(),
    running: true,
    onRewind: () => {},
  }));

  // One activity header for the whole run: the notification did not start a
  // turn of its own — splitting the turn is what used to collapse the work
  // log of a still-running agent.
  assertEquals(html.match(/class="agent-activity/g)?.length, 1);
  // The notification row is part of the work log: after the tool call it
  // reports on, and before the final text rendered below the log.
  const toolRow = html.indexOf("tool-timeline");
  const notificationRow = html.indexOf("Task agent_1 (調査) finished");
  const finalText = html.indexOf("the reaction");
  assert(toolRow !== -1, html);
  assert(notificationRow > toolRow, html);
  assert(finalText > notificationRow, html);
  // It renders like any other notification: a compact system row.
  assertStringIncludes(html, "notification-line-summary");
});

Deno.test("ConversationTurn: a context snapshot renders in the work log", () => {
  // The same rule puts the turn's other compact rows there: a dynamic
  // context snapshot (the skill catalog, an AGENTS.md update) is what the
  // model received, and ContextRow documents that a session shows it.
  const responses: AgentMessage[] = [
    {
      role: "context",
      provider: "skills",
      title: "スキル (3 件)",
      body: "<available_skills>\n- demo\n</available_skills>",
      timestamp: 2,
    },
    fauxAssistantMessage("done", { timestamp: 3 }) as AgentMessage,
  ];
  const html = renderToString(createElement(ConversationTurn, {
    turn: { user: user(1), responses },
    toolResults: new Map(),
    runningTools: new Map(),
    running: true,
    onRewind: () => {},
  }));

  assertEquals(html.match(/class="agent-activity/g)?.length, 1);
  const workLog = html.indexOf('class="agent-work-log"');
  const row = html.indexOf("スキル (3 件)");
  assert(workLog !== -1, html);
  assert(row > workLog, html);
});

Deno.test("a notification steered mid-run keeps the running turn last", () => {
  // The reported collapse along the whole client path (events → view →
  // turns): while a run is active, the completion notification is delivered
  // into that run, so it must not start a turn. The running turn stays the
  // last one and ChatView keeps its work log expanded
  // (running = isViewRunning && it is the last turn).
  let view = emptyView({
    id: "s1",
    workspaceId: "w1",
    name: "s",
    modelProvider: "p",
    modelId: "m",
    createdAt: 1,
    updatedAt: 1,
  });
  view = applyEvent(
    { type: "message_start", sessionId: "s1", message: user(1) },
    view,
  )!;
  view = applyEvent({ type: "agent_start", sessionId: "s1" }, view)!;
  // The tool-call turn, then the sub-agent's completion notification while
  // the run is still going.
  view = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: fauxAssistantMessage([fauxToolCall("task", {})], {
        timestamp: 2,
      }) as AgentMessage,
    },
    view,
  )!;
  view = applyEvent(
    {
      type: "message_end",
      sessionId: "s1",
      message: notification("task", 3, true),
    },
    view,
  )!;

  assertEquals(isViewRunning(view), true);
  const turns = buildTurns(view.messages);
  assertEquals(turns.length, 1);
  assertEquals(turns[0]!.user.role, "user");
  assertEquals(turns[0]!.responses.map((m) => m.role), [
    "assistant",
    "notification",
  ]);
});
