import { assert, assertEquals } from "@std/assert";
import type { SubagentStatus, TaskInfo } from "../shared/mod.ts";
import {
  endsWithToolCallSyntax,
  formatTaskCompletion,
  formatTaskOutput,
  subagentSystemPrompt,
} from "./subagent-format.ts";

function info(
  overrides: Partial<TaskInfo> & { status: SubagentStatus },
): TaskInfo {
  return {
    agentId: "agent_1",
    parentAgentId: "main",
    subagentType: "explore",
    description: "read the server routes",
    startedAt: 0,
    text: "",
    ...overrides,
  };
}

Deno.test("a failed task hands over the partial output", () => {
  const payload = formatTaskCompletion(
    info({
      status: "failed",
      text: "Found three call sites so far:\n- a.ts:12\n- b.ts:40",
    }),
    "Failed to process successful response (status 200)",
  );
  assertEquals(payload.status, "error");
  assertEquals(payload.title.includes("failed"), true);
  // The reason comes first, then what the run had produced before dying.
  assertEquals(payload.body.startsWith("Failed to process successful"), true);
  assertEquals(
    payload.body.includes("[partial output before the failure]"),
    true,
  );
  assertEquals(payload.body.includes("b.ts:40"), true);
});

Deno.test("a failed task with no output carries only the reason", () => {
  const payload = formatTaskCompletion(
    info({ status: "failed" }),
    "Provider is not configured: openai",
  );
  assertEquals(payload.body, "Provider is not configured: openai");
});

Deno.test("an aborted task reports the abort verb", () => {
  const payload = formatTaskCompletion(
    info({ status: "aborted", text: "half" }),
  );
  assertEquals(payload.title.includes("was aborted"), true);
  assertEquals(payload.body.includes("half"), true);
});

Deno.test("the partial output is bounded", () => {
  const payload = formatTaskCompletion(
    info({ status: "failed", text: "x".repeat(50_000) }),
    "boom",
  );
  // The notification becomes a message in the parent's transcript: it must
  // not carry an unbounded report.
  assertEquals(payload.body.length <= 64 * 1024 + 64, true);
});

Deno.test("endsWithToolCallSyntax detects a leaked tool block", () => {
  // The exact shape observed: a report cut mid-sentence, then the closing
  // tags of the tool-use dialect the provider failed to parse.
  assertEquals(
    endsWithToolCallSyntax(
      "- **ファイル**: `packages/server/route</parameter>\n</invoke>",
    ),
    true,
  );
  assertEquals(endsWithToolCallSyntax("done</tool_call>"), true);
  assertEquals(endsWithToolCallSyntax("all good</invoke>  "), true);
  // Ordinary reports are untouched.
  assertEquals(endsWithToolCallSyntax("### 1. [HIGH] DRY違反"), false);
  assertEquals(endsWithToolCallSyntax(""), false);
  // Mentioning the tag in prose is not an ending.
  assertEquals(endsWithToolCallSyntax("it ended with </invoke> tags"), false);
});

Deno.test("a finished report ending in tool syntax is flagged", () => {
  const payload = formatTaskCompletion(
    info({ status: "finished", text: "report…</parameter>\n</invoke>" }),
  );
  assertEquals(payload.status, "success");
  assertEquals(payload.body.includes("[warning]"), true);
  assertEquals(payload.body.includes("never executed"), true);
});

Deno.test("a clean finished report carries no warning", () => {
  const payload = formatTaskCompletion(
    info({ status: "finished", text: "report complete" }),
  );
  assertEquals(payload.body.includes("[warning]"), false);
  assertEquals(payload.body, "report complete");
});

Deno.test("formatTaskOutput shows the warning for task_output too", () => {
  const text = formatTaskOutput(
    info({ status: "finished", text: "partial</invoke>" }),
  );
  assertEquals(
    text.includes("agent_1 (explore, read the server routes): finished"),
    true,
  );
  assertEquals(text.includes("[warning]"), true);
});

Deno.test("formatTaskOutput keeps the running live tail readable", () => {
  const text = formatTaskOutput(
    info({ status: "running", text: "streaming…" }),
  );
  assertEquals(text.includes("Live output (tail):"), true);
  // A running task's text is a tail, not a result: no warning guessing.
  assertEquals(text.includes("[warning]"), false);
});

Deno.test("a sub-agent prompt is identity and protocol, with no guideline list", () => {
  const explore = subagentSystemPrompt("agent_2", "agent_1", "explore", "en");
  // The identity only the caller knows.
  assert(explore.includes("research sub-agent of Lumisca"));
  assert(explore.includes("Your own id is agent_2"));
  assert(explore.includes("send a message to agent_1 with send_message"));
  // The report protocol, and the one capability the tool set cannot state:
  // an explore sub-agent may investigate but not change anything.
  assert(explore.includes("complete final report as your last message"));
  assert(explore.includes("You are read-only"));
  // No guidelines: a session's prompt has none either, and the cross-call
  // guidance lives in the tools' own descriptions.
  assertEquals(explore.includes("Guidelines:"), false);
  assertEquals(
    explore.split("\n").filter((line) => line.startsWith("- ")),
    [],
  );

  // A general sub-agent carries the same shape, without the restriction.
  const general = subagentSystemPrompt("agent_3", "agent_1", "general", "en");
  assert(general.includes("coding sub-agent of Lumisca"));
  assertEquals(general.includes("You are read-only"), false);
});
