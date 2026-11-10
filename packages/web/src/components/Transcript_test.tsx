import { assert, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { fauxToolCall } from "@lumisca/core";
import type { AgentMessage, ToolCallBlock } from "../types.ts";
import { Transcript } from "./Transcript.tsx";

/** A transcript with no loaded history, so what these tests read is exactly
 * the live edge it draws. */
function render(parts: {
  streamingText?: string;
  liveTools?: ToolCallBlock[];
  runningTools?: Map<string, string>;
} = {}): string {
  return renderToString(createElement(Transcript, {
    messages: [] as AgentMessage[],
    onLoadOlder: () => false,
    hasOlder: false,
    loadingOlder: false,
    streamingText: parts.streamingText ?? "",
    liveTools: parts.liveTools ?? [],
    runningTools: parts.runningTools ?? new Map(),
    running: true,
    visualBase: "/api/sessions/s/visual/",
    attachBase: "/api/sessions/s/attachment/",
    onRewind: () => Promise.resolve(),
    onCardSend: () => {},
  }));
}

Deno.test("Transcript: a call that is executing is drawn before its message", () => {
  // The assistant message carrying the call arrives only when the step ends
  // (the SDK runs the step's tools inside the stream), so the row has to
  // come from the live calls: without it the work appears after it is done.
  const html = render({
    streamingText: "running the command",
    liveTools: [fauxToolCall("bash", { command: "sleep 10" }, "t1")],
    runningTools: new Map([["t1", "bash"]]),
  });

  assertStringIncludes(html, "tool-line-name");
  assertStringIncludes(html, "sleep 10");
  // Executing: the spinner, not the caret — the step's text is already
  // written, and the tool is what is still going.
  assertStringIncludes(html, "spin");
  assert(!html.includes('class="cursor"'));
  // Under the text it belongs to, like the row of a finished message.
  assert(html.indexOf("running the command") < html.indexOf("tool-line"));
});

Deno.test("Transcript: a live row that already returned is not spinning", () => {
  // Between tool_end and the message there is a row with no running entry:
  // it keeps its place (removing it would blink) and stops the spinner.
  const html = render({
    liveTools: [fauxToolCall("read", { path: "a.ts" }, "t2")],
  });

  assertStringIncludes(html, "tool-line-name");
  assertStringIncludes(html, "a.ts");
  assert(!html.includes("spin"));
});

Deno.test("Transcript: a card being written is drawn, not printed", () => {
  // The tail is read the same way a finished message is: the fence is never
  // shown as text, and the card draws from its first block.
  const html = render({
    streamingText:
      '確認します。\n\n```card\n<Card title="確認"><Text>進めますか。</Text>',
  });

  assertStringIncludes(html, "ui-card");
  assertStringIncludes(html, "確認します。");
  assert(!html.includes("```card"));
});

Deno.test("Transcript: the caret still marks text that is arriving", () => {
  const html = render({ streamingText: "half a sent" });

  assertStringIncludes(html, 'class="cursor"');
  assert(!html.includes("tool-line"));
});
