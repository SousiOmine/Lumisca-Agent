import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import {
  emptyStellaState,
  type StellaConversationState,
} from "../../stella-state.ts";
import { StellaTranscript } from "./StellaTranscript.tsx";

/** Render a conversation. What arrives here is already the conversation —
 * the server's projection never sends the model's rows — so the assertions
 * are about what a conversation looks like, not about filtering. */
function render(state: Partial<StellaConversationState>): string {
  initLocale("ja");
  return renderToString(createElement(StellaTranscript, {
    conversation: { ...emptyStellaState("Aide"), ...state },
    visualBase: "/api/sessions/s/visual/",
    attachBase: "/api/sessions/s/attachment/",
    onRewind: () => {},
    onSend: () => {},
  }));
}

Deno.test("StellaTranscript: the words come out in order", () => {
  const html = render({
    entries: [
      {
        role: "user",
        text: "README を直して",
        cards: [],
        attachments: [],
        timestamp: 1,
      },
      {
        role: "assistant",
        text: "直しました。",
        cards: [],
        attachments: [],
        timestamp: 2,
      },
      {
        role: "user",
        text: "ありがとう",
        cards: [],
        attachments: [],
        timestamp: 3,
      },
    ],
  });

  const first = html.indexOf("README を直して");
  const second = html.indexOf("直しました。");
  const third = html.indexOf("ありがとう");
  assertStringIncludes(html, "msg-user-wrap");
  assertEquals(first !== -1 && second > first && third > second, true, html);
});

Deno.test("StellaTranscript: a card renders with its markup", () => {
  const markup = '<Card title="確認"><Text>進めますか。</Text></Card>';
  const html = render({
    entries: [
      {
        role: "assistant",
        text: "確認します。",
        cards: [markup],
        attachments: [],
        timestamp: 1,
      },
    ],
  });

  assertStringIncludes(html, "ui-card");
  assertStringIncludes(html, "確認");
  assertStringIncludes(html, "進めますか。");
});

Deno.test("StellaTranscript: the streaming reply carries its own cursor", () => {
  const html = render({ streamingText: "書いています", running: true });
  assertStringIncludes(html, "書いています");
  assertStringIncludes(html, "cursor");
  // The dot is for the wait before the first token; once text arrives the
  // cursor says the same thing without a second mark.
  assertEquals(html.includes("chat-running"), false, html);
});

Deno.test("StellaTranscript: a run with nothing to show yet is a dot", () => {
  const html = render({ running: true });
  assertStringIncludes(html, "chat-running");
  assertStringIncludes(html, "作業中");
});

Deno.test("StellaTranscript: the last failure is shown, not swallowed", () => {
  const html = render({ error: "provider not configured" });
  assertStringIncludes(html, "provider not configured");
  assertStringIncludes(html, 'role="alert"');
});

Deno.test("StellaTranscript: nothing of the model's machinery can appear", () => {
  // The projection is the server's job (see stella-stream_test); this is the
  // structural check: the component has no way to draw a tool row, a work
  // log or a context row even if one were passed.
  const html = render({
    entries: [{
      role: "assistant",
      text: "答えです。",
      cards: [],
      attachments: [],
      timestamp: 1,
    }],
  });
  for (
    const forbidden of [
      "tool-timeline",
      "agent-work-log",
      "agent-activity",
      "notification-timeline",
    ]
  ) {
    assertEquals(html.includes(forbidden), false, forbidden);
  }
});
