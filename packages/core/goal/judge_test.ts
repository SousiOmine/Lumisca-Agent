import { assertEquals } from "@std/assert";
import {
  buildGoalJudgeUserText,
  lastAssistantOutput,
  MAX_GOAL_TRANSCRIPT_CHARS,
  parseGoalVerdict,
} from "./judge.ts";
import type { AgentMessage } from "@lumisca/core";

/** Test-only helper: render recent agent messages as plain text (kept for
 * tests/debug). Mirrors the now-removed `excerptTranscript` from judge.ts. */
function excerptTranscript(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = message.role;
    const m = message as {
      content?: unknown;
      fullPrompt?: unknown;
      title?: unknown;
      body?: unknown;
    };
    let text = "";
    if (typeof m.fullPrompt === "string") text = m.fullPrompt;
    else if (typeof m.title === "string" || typeof m.body === "string") {
      text = `${m.title ?? ""}\n${m.body ?? ""}`.trim();
    } else {
      const content = m.content as
        | string
        | Array<{ type: string; text?: string }>
        | undefined;
      if (content !== undefined) {
        text = Array.isArray(content)
          ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
          : String(content);
      }
    }
    if (text.trim().length === 0) continue;
    lines.push(`[${role}] ${text}`);
  }
  const joined = lines.join("\n\n");
  if (joined.length <= MAX_GOAL_TRANSCRIPT_CHARS) return joined;
  return joined.slice(joined.length - MAX_GOAL_TRANSCRIPT_CHARS);
}

Deno.test("parseGoalVerdict: parses an achieved verdict", () => {
  const verdict = parseGoalVerdict(
    '{"achieved": true, "reason": "all tests pass", "nextPrompt": ""}',
  );
  assertEquals(verdict, {
    achieved: true,
    reason: "all tests pass",
    nextPrompt: "",
  });
});

Deno.test("parseGoalVerdict: parses an unachieved verdict with the next prompt", () => {
  const verdict = parseGoalVerdict(
    '{"achieved": false, "reason": "login test still fails", "nextPrompt": "Fix login.ts and rerun deno test"}',
  );
  assertEquals(verdict?.achieved, false);
  assertEquals(verdict?.reason, "login test still fails");
  assertEquals(
    verdict?.nextPrompt,
    "Fix login.ts and rerun deno test",
  );
});

Deno.test("parseGoalVerdict: tolerates fences and surrounding prose", () => {
  const verdict = parseGoalVerdict(
    'Here is my judgement:\n```json\n{"achieved": true, "reason": "done"}\n```',
  );
  assertEquals(verdict, { achieved: true, reason: "done", nextPrompt: "" });
});

Deno.test("parseGoalVerdict: rejects malformed verdicts", () => {
  // No JSON object.
  assertEquals(parseGoalVerdict("all good"), null);
  // Wrong types.
  assertEquals(
    parseGoalVerdict('{"achieved": "yes", "reason": "x", "nextPrompt": "y"}'),
    null,
  );
  // Empty reason.
  assertEquals(
    parseGoalVerdict('{"achieved": true, "reason": "  ", "nextPrompt": ""}'),
    null,
  );
  // Unachieved without a next instruction cannot drive the loop.
  assertEquals(
    parseGoalVerdict('{"achieved": false, "reason": "not yet"}'),
    null,
  );
  assertEquals(
    parseGoalVerdict(
      '{"achieved": false, "reason": "not yet", "nextPrompt": "   "}',
    ),
    null,
  );
});

Deno.test("buildGoalJudgeUserText: carries goal, progress, and transcript", () => {
  const text = buildGoalJudgeUserText({
    goal: "全テストを通す",
    transcript: "some work",
    iteration: 2,
    maxIterations: 10,
  });
  assertEquals(text.includes("全テストを通す"), true);
  assertEquals(text.includes("2/10"), true);
  assertEquals(text.includes("some work"), true);
  assertEquals(text.includes("LAST OUTPUT"), true);
});

function textMessage(
  role: AgentMessage["role"],
  timestamp: number,
  text: string,
): AgentMessage {
  return { role, timestamp, content: [{ type: "text", text }] } as AgentMessage;
}

Deno.test("excerptTranscript: renders roles and keeps long transcripts bounded", () => {
  const excerpt = excerptTranscript([
    textMessage("user", 1, "do it"),
    textMessage("assistant", 2, "working"),
  ]);
  assertEquals(excerpt.includes("[user] do it"), true);
  assertEquals(excerpt.includes("[assistant] working"), true);

  const long = "x".repeat(MAX_GOAL_TRANSCRIPT_CHARS + 100);
  const bounded = excerptTranscript([textMessage("assistant", 3, long)]);
  assertEquals(bounded.length <= MAX_GOAL_TRANSCRIPT_CHARS, true);
});

Deno.test("lastAssistantOutput: uses only the latest assistant message", () => {
  assertEquals(
    lastAssistantOutput([
      textMessage("user", 1, "do it"),
      textMessage("assistant", 2, "first"),
      textMessage("assistant", 3, "latest"),
    ]),
    "latest",
  );
  // Later non-assistant messages do not hide the last assistant output.
  assertEquals(
    lastAssistantOutput([
      textMessage("assistant", 2, "work done"),
      textMessage("user", 3, "hint"),
    ]),
    "work done",
  );
  assertEquals(lastAssistantOutput([textMessage("user", 1, "hi")]), "");
  assertEquals(lastAssistantOutput([]), "");
});
