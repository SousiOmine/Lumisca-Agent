import { assert, assertEquals, assertThrows } from "@std/assert";
import { LumiscaDb } from "../db/mod.ts";
import { CoreError } from "../errors.ts";
import { createMessageRepo } from "../session/messages.ts";
import type { AgentMessage } from "../ai/types.ts";
import { TOOL_HISTORY_SEARCH } from "../shared/mod.ts";
import { toolText } from "../test-utils.ts";
import { createHistorySearchTool, MAX_HISTORY_LIMIT } from "./history.ts";

/** A tool bound to one in-memory conversation, plus the repo that fills it. */
function setup() {
  const db = LumiscaDb.openInMemory();
  db.db.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 't', 0)",
  ).run();
  db.db.prepare(
    `INSERT INTO sessions (id, workspace_id, name, model_provider, model_id, created_at, updated_at)
     VALUES (?, 'ws', 't', 'faux', 'model', 0, 0)`,
  ).run("s1");
  const repo = createMessageRepo(db);
  const tool = createHistorySearchTool({
    messages: (window) => repo.listBetween("s1", window),
  });
  return { db, repo, tool };
}

/** Append one user message. */
function say(
  repo: ReturnType<typeof createMessageRepo>,
  text: string,
  timestamp: number,
): void {
  repo.append("s1", { role: "user", content: text, timestamp } as AgentMessage);
}

/** Run the tool and return the text the model reads. */
async function run(
  tool: ReturnType<typeof createHistorySearchTool>,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await tool.execute("call-1", args as never, undefined);
  return toolText(result as never);
}

/** A local-time epoch for the given calendar day and hour. */
function localDay(day: string, hour = 12): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!, hour).getTime();
}

Deno.test("history_search: the tool is the preloaded one", () => {
  const { db, tool } = setup();
  try {
    assertEquals(tool.name, TOOL_HISTORY_SEARCH);
    assertEquals(tool.name, "history_search");
  } finally {
    db.close();
  }
});

Deno.test("history_search: every word must appear, in any order and case", async () => {
  const { db, repo, tool } = setup();
  try {
    say(repo, "Deploy the RUST service to staging", localDay("2026-10-01"));
    say(repo, "The rust service build failed", localDay("2026-10-02"));
    say(repo, "Unrelated note about lunch", localDay("2026-10-03"));

    const both = await run(tool, { query: "service RUST" });
    assert(both.includes("Found 2 message(s)"), both);
    assert(both.includes("Deploy the RUST service"), both);
    assert(both.includes("build failed"), both);
    assert(!both.includes("lunch"), both);

    const narrowed = await run(tool, { query: "build rust" });
    assert(narrowed.includes("Found 1 message(s)"), narrowed);
    assert(narrowed.includes("build failed"), narrowed);

    // Japanese has no word spaces: one term is the whole query.
    say(repo, "設定ファイルの場所を教えて", localDay("2026-10-04"));
    const japanese = await run(tool, { query: "設定ファイル" });
    assert(japanese.includes("設定ファイルの場所"), japanese);
  } finally {
    db.close();
  }
});

Deno.test("history_search: terms are literal, not regular expressions", async () => {
  const { db, repo, tool } = setup();
  try {
    say(repo, "Price is $5 (tax included)", localDay("2026-10-01"));
    // A term with regex metacharacters must match the literal text instead
    // of compiling into a pattern.
    const result = await run(tool, { query: "$5 (tax" });
    assert(result.includes("Found 1 message(s)"), result);
    assert(result.includes("Price is $5"), result);
    // And a pattern that would be invalid as a regex is still a fine term.
    const odd = await run(tool, { query: "C++" });
    assertEquals(odd.includes("No message"), true, odd);
  } finally {
    db.close();
  }
});

Deno.test("history_search: no query lists the period, newest last", async () => {
  const { db, repo, tool } = setup();
  try {
    say(repo, "first", localDay("2026-10-01", 9));
    say(repo, "second", localDay("2026-10-02", 9));
    say(repo, "third", localDay("2026-10-03", 9));

    const all = await run(tool);
    assert(all.includes("Found 3 message(s)"), all);
    const first = all.indexOf("first");
    const third = all.indexOf("third");
    assert(first !== -1 && third !== -1 && first < third, all);

    const period = await run(tool, { from: "2026-10-02", to: "2026-10-02" });
    assert(period.includes("Found 1 message(s)"), period);
    assert(period.includes("second"), period);
    assert(period.includes("on 2026-10-02 (local time)"), period);
    assert(!period.includes("first"), period);
    assert(!period.includes("third"), period);
  } finally {
    db.close();
  }
});

Deno.test("history_search: the newest matches fill the limit, shown in order", async () => {
  const { db, repo, tool } = setup();
  try {
    for (let i = 1; i <= 5; i++) {
      say(repo, `note ${i}`, localDay("2026-10-01", i));
    }
    const result = await run(tool, { limit: 2 });
    assert(result.includes("Found 5 message(s)"), result);
    // The two newest survive, and they read oldest-first.
    assert(result.includes("note 5"), result);
    assert(result.includes("note 4"), result);
    assert(!result.includes("note 3"), result);
    assert(result.indexOf("note 4") < result.indexOf("note 5"), result);
    assert(result.includes("raise limit"), result);
  } finally {
    db.close();
  }
});

Deno.test("history_search: arguments are checked, not clamped", () => {
  const { db, tool } = setup();
  try {
    assertThrows(
      () =>
        tool.execute("c", { limit: MAX_HISTORY_LIMIT + 1 } as never, undefined),
      CoreError,
    );
    assertThrows(
      () => tool.execute("c", { limit: 0 } as never, undefined),
      CoreError,
    );
    // A date that does not exist must not roll over into the next month.
    assertThrows(
      () => tool.execute("c", { from: "2026-02-30" } as never, undefined),
      CoreError,
    );
    assertThrows(
      () => tool.execute("c", { from: "10/01/2026" } as never, undefined),
      CoreError,
    );
    assertThrows(
      () =>
        tool.execute(
          "c",
          { from: "2026-10-02", to: "2026-10-01" } as never,
          undefined,
        ),
      CoreError,
    );
  } finally {
    db.close();
  }
});

Deno.test("history_search: the same day at both ends is allowed", async () => {
  const { db, repo, tool } = setup();
  try {
    say(repo, "same day", localDay("2026-10-01", 23));
    const result = await run(tool, { from: "2026-10-01", to: "2026-10-01" });
    assert(result.includes("same day"), result);
  } finally {
    db.close();
  }
});

Deno.test("history_search: tool results are named and kept to their head", async () => {
  const { db, repo, tool } = setup();
  try {
    repo.append("s1", {
      role: "assistant",
      content: [
        { type: "text", text: "Running the tests now." },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "deno test" },
        },
      ],
      api: "openai-completions",
      provider: "faux",
      model: "model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: "toolUse",
      timestamp: localDay("2026-10-01", 10),
    } as AgentMessage);
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: `BEGIN ${"x".repeat(2000)} END` }],
      isError: false,
      timestamp: localDay("2026-10-01", 11),
    } as AgentMessage);

    // The assistant turn: its text and the names of the tools it called.
    const calls = await run(tool, { query: "tests" });
    assert(calls.includes("(tool calls: bash)"), calls);
    assert(calls.includes("Running the tests now."), calls);

    // The tool result: named after the tool, and cut to its head.
    const output = await run(tool, { query: "begin" });
    assert(output.includes("tool result: bash"), output);
    assert(output.includes("BEGIN"), output);
    assert(!output.includes("END"), output);
    assert(output.includes("truncated to the first"), output);
  } finally {
    db.close();
  }
});

Deno.test("history_search: an empty conversation says so, with a next step", async () => {
  const { db, tool } = setup();
  try {
    const empty = await run(tool);
    assert(empty.includes("No messages have been saved"), empty);

    const missed = await run(tool, { query: "anything" });
    assert(missed.includes("No message"), missed);
    assert(missed.includes("omit the query"), missed);
  } finally {
    db.close();
  }
});

Deno.test("history_search: its own earlier results are not history", async () => {
  const { db, repo, tool } = setup();
  try {
    say(repo, "The code word is pelican", localDay("2026-10-01"));
    // A previous search would otherwise echo the word it looked for, so a
    // second search would find the first search instead of the conversation.
    repo.append("s1", {
      role: "toolResult",
      toolCallId: "call-0",
      toolName: TOOL_HISTORY_SEARCH,
      content: [{
        type: "text",
        text: 'Found 1 message(s) matching "pelican".\n\n[user]\nThe code ' +
          "word is pelican",
      }],
      isError: false,
      timestamp: localDay("2026-10-01", 13),
    } as AgentMessage);

    const result = await run(tool, { query: "pelican" });
    assert(result.includes("Found 1 message(s)"), result);
    assert(!result.includes("tool result: history_search"), result);
  } finally {
    db.close();
  }
});

Deno.test("history_search: an image-only prompt is a turn, not a hole", async () => {
  const { db, repo, tool } = setup();
  try {
    repo.append("s1", {
      role: "user",
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      timestamp: localDay("2026-10-01"),
    } as AgentMessage);

    const result = await run(tool);
    assert(result.includes("(attached image, no text)"), result);
  } finally {
    db.close();
  }
});
