import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
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

/** Helper: build a tool-result message for the present tool. */
function presentResult(
  timestamp: number,
  files: Array<{ path: string; description?: string }>,
  isError = false,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${timestamp}`,
    toolName: "present",
    content: [{ type: "text", text: "ok" }],
    details: { files },
    isError,
    timestamp,
  } satisfies ToolResultMessage;
}

/** Helper: build a non-present tool-result message. */
function otherResult(timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${timestamp}`,
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    details: {},
    isError: false,
    timestamp,
  } satisfies ToolResultMessage;
}

Deno.test("deliverablesOf: empty messages → empty array", () => {
  assertEquals(deliverablesOf([]), []);
});

Deno.test("deliverablesOf: ignores non-toolResult messages", () => {
  assertEquals(deliverablesOf([user(1)]), []);
});

Deno.test("deliverablesOf: ignores non-present tool results", () => {
  assertEquals(deliverablesOf([otherResult(1)]), []);
});

Deno.test("deliverablesOf: ignores error tool results", () => {
  assertEquals(
    deliverablesOf([presentResult(1, [{ path: "out.txt" }], true)]),
    [],
  );
});

Deno.test("deliverablesOf: extracts files from a single present call", () => {
  const result = deliverablesOf([
    presentResult(1, [
      { path: "a.md", description: "readme" },
      { path: "b.txt" },
    ]),
  ]);
  assertEquals(result.length, 2);
  assertEquals(result[0], { path: "a.md", description: "readme" });
  assertEquals(result[1], { path: "b.txt", description: undefined });
});

Deno.test("deliverablesOf: deduplicates by path, keeps latest description", () => {
  const result = deliverablesOf([
    presentResult(1, [{ path: "a.md", description: "first" }]),
    presentResult(2, [{ path: "a.md", description: "second" }]),
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0], { path: "a.md", description: "second" });
});

Deno.test("deliverablesOf: preserves order of first appearance", () => {
  const result = deliverablesOf([
    presentResult(1, [{ path: "z.txt" }, { path: "a.txt" }]),
    presentResult(2, [{ path: "m.txt" }]),
  ]);
  assertEquals(result.map((f) => f.path), ["z.txt", "a.txt", "m.txt"]);
});

Deno.test("deliverablesOf: handles missing details gracefully", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "present",
    content: [],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage;
  assertEquals(deliverablesOf([msg]), []);
});

Deno.test("deliverablesOf: handles details with non-array files", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "present",
    content: [],
    details: { files: "not-an-array" },
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage;
  assertEquals(deliverablesOf([msg]), []);
});

Deno.test("deliverablesOf: skips entries with missing path", () => {
  const result = deliverablesOf([
    presentResult(1, [
      { path: "ok.txt" },
      {} as unknown as { path: string },
    ]),
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.path, "ok.txt");
});

Deno.test("deliverablesOf: mixed messages extract only present results", () => {
  const result = deliverablesOf([
    user(1),
    otherResult(2),
    presentResult(3, [{ path: "out.md" }]),
    otherResult(4),
  ]);
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
