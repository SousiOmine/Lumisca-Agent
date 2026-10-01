import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { fauxAssistantMessage, fauxToolCall } from "@lumisca/core";
import type { AgentMessage, ToolResultMessage } from "../../types.ts";
import {
  Deliverables,
  deliverablesOf,
  fileVisual,
  typeLine,
} from "./Deliverables.tsx";

/** Helper: build a minimal user message. */
function user(timestamp: number): AgentMessage {
  return { role: "user", content: "go", timestamp };
}

/** Helper: build an assistant message calling the present tool once per id.
 * The declared files live in the tool's result, so the arguments the model
 * sent carry none — only the pairs of call id and result matter here. */
function presentCalls(...ids: string[]): AgentMessage {
  return fauxAssistantMessage(
    ids.map((id) => fauxToolCall("present", { files: [] }, id)),
    { timestamp: 1 },
  ) as AgentMessage;
}

/** Helper: build a tool-result message of the present tool whose `details`
 * are exactly what the test needs (the file list lives under `files`, but a
 * transcript from an older version may carry anything). */
function presentResult(
  id: string,
  details: unknown = { files: [] },
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "present",
    content: [{ type: "text", text: "ok" }],
    details,
    isError,
    timestamp: 1,
  } satisfies ToolResultMessage;
}

/** Helper: build a successful result of a tool other than present. */
function otherResult(id: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    details: {},
    isError: false,
    timestamp: 1,
  } satisfies ToolResultMessage;
}

/** Helper: index results by the tool call they answer, the way ChatView
 * builds the map the timeline and the cards both read. */
function resultsOf(
  ...results: ToolResultMessage[]
): Map<string, ToolResultMessage> {
  return new Map(results.map((result) => [result.toolCallId, result]));
}

Deno.test("deliverablesOf: no messages → empty array", () => {
  assertEquals(deliverablesOf([], resultsOf()), []);
});

Deno.test("deliverablesOf: ignores messages that carry no present call", () => {
  assertEquals(deliverablesOf([user(1)], resultsOf()), []);
});

Deno.test("deliverablesOf: ignores tool calls other than present", () => {
  const read = fauxAssistantMessage(
    [fauxToolCall("read", { path: "a.md" }, "tc-1")],
    { timestamp: 1 },
  ) as AgentMessage;
  // The result is in the map, but the call is not the present tool.
  assertEquals(deliverablesOf([read], resultsOf(otherResult("tc-1"))), []);
});

Deno.test("deliverablesOf: ignores a call whose result has not arrived", () => {
  assertEquals(deliverablesOf([presentCalls("tc-1")], resultsOf()), []);
});

Deno.test("deliverablesOf: ignores error results", () => {
  assertEquals(
    deliverablesOf(
      [presentCalls("tc-1")],
      resultsOf(presentResult("tc-1", { files: [{ path: "out.txt" }] }, true)),
    ),
    [],
  );
});

Deno.test("deliverablesOf: extracts files from a single present call", () => {
  const files = [
    { path: "a.md", description: "readme" },
    { path: "b.txt" },
  ];
  const result = deliverablesOf(
    [presentCalls("tc-1")],
    resultsOf(presentResult("tc-1", { files })),
  );
  assertEquals(result, [
    { path: "a.md", description: "readme" },
    { path: "b.txt", description: undefined },
  ]);
});

Deno.test("deliverablesOf: pairs a call with its result by tool-call id", () => {
  // The rows of the turn need not carry the result: the call is paired with
  // the map by id, which is what keeps the cards with the message that
  // declared them when the result lands outside the turn's own rows.
  const result = deliverablesOf(
    [presentCalls("tc-1")],
    resultsOf(presentResult("tc-1", { files: [{ path: "out.md" }] })),
  );
  assertEquals(result.map((file) => file.path), ["out.md"]);
});

Deno.test("deliverablesOf: deduplicates by path, keeps latest description", () => {
  const result = deliverablesOf(
    [presentCalls("tc-1", "tc-2")],
    resultsOf(
      presentResult("tc-1", {
        files: [{ path: "a.md", description: "first" }],
      }),
      presentResult("tc-2", {
        files: [{ path: "a.md", description: "second" }],
      }),
    ),
  );
  assertEquals(result.length, 1);
  assertEquals(result[0], { path: "a.md", description: "second" });
});

Deno.test("deliverablesOf: a later declaration without a description keeps the earlier one", () => {
  const result = deliverablesOf(
    [presentCalls("tc-1", "tc-2")],
    resultsOf(
      presentResult("tc-1", {
        files: [{ path: "a.md", description: "first" }],
      }),
      presentResult("tc-2", { files: [{ path: "a.md" }] }),
    ),
  );
  assertEquals(result[0], { path: "a.md", description: "first" });
});

Deno.test("deliverablesOf: preserves order of first appearance", () => {
  const result = deliverablesOf(
    [presentCalls("tc-1", "tc-2")],
    resultsOf(
      presentResult("tc-1", { files: [{ path: "z.txt" }, { path: "a.txt" }] }),
      presentResult("tc-2", { files: [{ path: "m.txt" }] }),
    ),
  );
  assertEquals(result.map((file) => file.path), ["z.txt", "a.txt", "m.txt"]);
});

Deno.test("deliverablesOf: handles missing details gracefully", () => {
  assertEquals(
    deliverablesOf(
      [presentCalls("tc-1")],
      resultsOf(presentResult("tc-1", undefined)),
    ),
    [],
  );
});

Deno.test("deliverablesOf: handles details with non-array files", () => {
  assertEquals(
    deliverablesOf(
      [presentCalls("tc-1")],
      resultsOf(presentResult("tc-1", { files: "not-an-array" })),
    ),
    [],
  );
});

Deno.test("deliverablesOf: skips entries with missing path", () => {
  const result = deliverablesOf(
    [presentCalls("tc-1")],
    resultsOf(
      presentResult("tc-1", {
        files: [{ path: "ok.txt" }, {}, "nope"],
      }),
    ),
  );
  assertEquals(result.length, 1);
  assertEquals(result[0]!.path, "ok.txt");
});

Deno.test("deliverablesOf: mixed messages extract only the present calls", () => {
  const read = fauxAssistantMessage(
    [fauxToolCall("read", { path: "a.md" }, "tc-2")],
    { timestamp: 1 },
  ) as AgentMessage;
  const result = deliverablesOf(
    [user(1), read, presentCalls("tc-1")],
    resultsOf(
      otherResult("tc-2"),
      presentResult("tc-1", { files: [{ path: "out.md" }] }),
    ),
  );
  assertEquals(result.length, 1);
  assertEquals(result[0]!.path, "out.md");
});

Deno.test("fileVisual: takes the last segment as the name", () => {
  assertEquals(fileVisual("Lumisca-Agent/docs/report.pdf").name, "report.pdf");
  assertEquals(fileVisual("report.pdf").name, "report.pdf");
});

Deno.test("fileVisual: reads Windows separators", () => {
  const visual = fileVisual("Lumisca-Agent\\docs\\report.pdf");
  assertEquals(visual.name, "report.pdf");
  assertEquals(visual.kind, "document");
});

Deno.test("fileVisual: uppercases the extension", () => {
  assertEquals(fileVisual("data/x.CSV").extension, "CSV");
});

Deno.test("fileVisual: classifies a known extension", () => {
  assertEquals(fileVisual("a.pdf").kind, "document");
  assertEquals(fileVisual("a.csv").kind, "spreadsheet");
  assertEquals(fileVisual("a.pptx").kind, "presentation");
  assertEquals(fileVisual("a.png").kind, "image");
  assertEquals(fileVisual("a.ts").kind, "code");
  assertEquals(fileVisual("a.zip").kind, "archive");
  assertEquals(fileVisual("a.mp3").kind, "audio");
  assertEquals(fileVisual("a.mp4").kind, "video");
});

Deno.test("fileVisual: unknown extension keeps the extension, drops the kind", () => {
  const visual = fileVisual("model.gguf");
  assertEquals(visual.kind, undefined);
  assertEquals(visual.extension, "GGUF");
  assertEquals(visual.name, "model.gguf");
});

Deno.test("fileVisual: a name without an extension has neither", () => {
  const visual = fileVisual("Makefile");
  assertEquals(visual.kind, undefined);
  assertEquals(visual.extension, "");
  assertEquals(visual.name, "Makefile");
});

Deno.test("fileVisual: a dotfile is not read as an extension", () => {
  const visual = fileVisual(".gitignore");
  assertEquals(visual.kind, undefined);
  assertEquals(visual.extension, "");
  assertEquals(visual.name, ".gitignore");
});

Deno.test("fileVisual: an extension picks its own icon over the kind's", () => {
  assertNotEquals(fileVisual("a.pdf").icon, fileVisual("a.md").icon);
  // Same kind, no icon of their own: both fall to the kind's icon.
  assertEquals(fileVisual("a.yaml").icon, fileVisual("a.toml").icon);
});

Deno.test("typeLine: joins the kind label and the extension", () => {
  assertEquals(typeLine("ドキュメント", "PDF"), "ドキュメント · PDF");
});

Deno.test("typeLine: an unclassified extension shows alone", () => {
  assertEquals(typeLine(undefined, "DB"), "DB");
});

Deno.test("typeLine: a name with neither renders as an empty line", () => {
  assertEquals(typeLine(undefined, ""), "");
});

Deno.test("Deliverables: renders nothing while the list is empty", () => {
  assertEquals(
    renderToString(createElement(Deliverables, { deliverables: [] })),
    "",
  );
});

Deno.test("Deliverables: lists the title, each file and its type line", () => {
  const html = renderToString(
    createElement(Deliverables, {
      deliverables: [
        { path: "Lumisca-Agent/tmp/report.pdf", description: "調査レポート" },
        { path: "Lumisca-Agent/lumisca.db" },
      ],
    }),
  );
  assertStringIncludes(html, "成果物");
  assertStringIncludes(html, "report.pdf");
  assertStringIncludes(html, "ドキュメント · PDF");
  assertStringIncludes(html, "調査レポート");
  // An unclassified file shows its extension alone: no dangling separator.
  assertStringIncludes(html, 'class="deliverable-meta">DB<');
  // The copy action names the file it copies.
  assertStringIncludes(html, "パスをコピー: Lumisca-Agent/lumisca.db");
});

Deno.test("Deliverables: a file without a description has no description line", () => {
  const html = renderToString(
    createElement(Deliverables, {
      deliverables: [{ path: "Lumisca-Agent/a.md" }],
    }),
  );
  assert(!html.includes("deliverable-desc"), html);
});
