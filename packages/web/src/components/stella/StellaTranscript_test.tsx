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
    author: { id: "a1", name: "Aide", icon: "" },
    visualBase: "/api/sessions/s/visual/",
    attachBase: "/api/sessions/s/attachment/",
    onRewind: () => {},
    onSend: () => {},
    onLoadOlder: () => false,
    loadingOlder: false,
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
  assertEquals(html.includes("stella-running"), false, html);
});

Deno.test("StellaTranscript: a run with nothing to show yet is typing dots", () => {
  const html = render({ running: true });
  // The wait is drawn where the reply will go: the agent's face in the
  // avatar column, then three dots. The word itself stays for a screen
  // reader (the dots say nothing to one).
  assertStringIncludes(html, "stella-running");
  assertStringIncludes(html, "stella-typing-dot");
  assertStringIncludes(html, "作業中");
  assertStringIncludes(html, "visually-hidden");
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

Deno.test("StellaTranscript: a conversation reads as messages, not rows", () => {
  const html = render({
    entries: [
      {
        role: "user",
        text: "直して",
        cards: [],
        attachments: [],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        text: "直しました。",
        cards: [],
        attachments: [],
        timestamp: Date.now() + 1,
      },
    ],
  });
  // The reader's own message keeps the shared capsule (the same element
  // code mode draws), and the agent's answer sits in the avatar column.
  assertStringIncludes(html, "msg-user-wrap");
  assertStringIncludes(html, "stella-msg");
  assertStringIncludes(html, "stella-msg-avatar");
  // Each message carries the time it was said under it.
  assertStringIncludes(html, "msg-time");
});

Deno.test("StellaTranscript: a run of the agent's messages shares one avatar", () => {
  const now = Date.now();
  const html = render({
    entries: [
      {
        role: "user",
        text: "一つ目",
        cards: [],
        attachments: [],
        timestamp: now,
      },
      {
        role: "assistant",
        text: "返事一",
        cards: [],
        attachments: [],
        timestamp: now + 1,
      },
      {
        role: "assistant",
        text: "返事二",
        cards: [],
        attachments: [],
        timestamp: now + 2,
      },
    ],
  });
  // Two replies in a row read as one answer: the second is a continuation
  // (no repeated face, the gap closes), so the list does not look like the
  // agent spoke three separate times.
  assertEquals((html.match(/class="stella-msg continued"/g) ?? []).length, 1);
  // One face for the run (`--agent-avatar-hue` also carries the name, so
  // the element is counted by its class attribute).
  assertEquals((html.match(/class="agent-avatar/g) ?? []).length, 1);
});

Deno.test("StellaTranscript: a new day opens a separator", () => {
  const today = new Date(2026, 8, 15, 12, 0).getTime();
  const yesterday = new Date(2026, 8, 14, 12, 0).getTime();
  const html = render({
    entries: [
      {
        role: "user",
        text: "昨日の話",
        cards: [],
        attachments: [],
        timestamp: yesterday,
      },
      {
        role: "user",
        text: "今日の話",
        cards: [],
        attachments: [],
        timestamp: today,
      },
    ],
  });
  const separators = html.match(/class="stella-day"/g) ?? [];
  assertEquals(separators.length, 2, "one separator per day");
  assertStringIncludes(html, "昨日");
  assertStringIncludes(html, "今日");
});
