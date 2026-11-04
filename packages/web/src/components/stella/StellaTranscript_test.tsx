import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
    uploadBase: "/api/stella/conversations/a1/upload",
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
        card: null,
        attachments: [],
        files: [],
        timestamp: 1,
      },
      {
        role: "assistant",
        text: "直しました。",
        card: null,
        attachments: [],
        files: [],
        timestamp: 2,
      },
      {
        role: "user",
        text: "ありがとう",
        card: null,
        attachments: [],
        files: [],
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
        card: markup,
        attachments: [],
        files: [],
        timestamp: 1,
      },
    ],
  });

  assertStringIncludes(html, "ui-card");
  assertStringIncludes(html, "確認");
  assertStringIncludes(html, "進めますか。");
});

Deno.test("StellaTranscript: a message never streams", () => {
  // The agent's own text is its working notes and never arrives here, so a
  // run shows the typing dots alone until it SENDS something. There is no
  // cursor and no half-written bubble to draw.
  const html = render({ running: true });
  assertStringIncludes(html, "stella-running");
  assertEquals(html.includes("cursor"), false, html);
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
      card: null,
      attachments: [],
      files: [],
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
        card: null,
        attachments: [],
        files: [],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        text: "直しました。",
        card: null,
        attachments: [],
        files: [],
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
  // The reader's own message: the time is the RIGHTMOST thing there, so the
  // clock does not move when the actions appear on hover. (The agent's
  // message mirrors it — the clock first, then its copy control — because
  // that text starts on the left.)
  const userMeta = html.slice(
    html.indexOf('class="msg-meta"'),
    html.indexOf('class="msg-meta start"'),
  );
  const order = [...userMeta.matchAll(/class="(msg-action-btn|msg-time)"/g)]
    .map((match) => match[1]);
  assertEquals(order.at(-1), "msg-time", order.join(","));
  // …and the agent's answer can be copied too, after its clock.
  const agentMeta = html.slice(html.indexOf('class="msg-meta start"'));
  const agentOrder = [
    ...agentMeta.matchAll(/class="(msg-action-btn|msg-time)"/g),
  ].map((match) => match[1]);
  assertEquals(agentOrder[0], "msg-time", agentOrder.join(","));
  assert(agentOrder.includes("msg-action-btn"), agentOrder.join(","));
});

Deno.test("StellaTranscript: a run of the agent's messages shares one avatar", () => {
  const now = Date.now();
  const html = render({
    entries: [
      {
        role: "user",
        text: "一つ目",
        card: null,
        attachments: [],
        files: [],
        timestamp: now,
      },
      {
        role: "assistant",
        text: "返事一",
        card: null,
        attachments: [],
        files: [],
        timestamp: now + 1,
      },
      {
        role: "assistant",
        text: "返事二",
        card: null,
        attachments: [],
        files: [],
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
        card: null,
        attachments: [],
        files: [],
        timestamp: yesterday,
      },
      {
        role: "user",
        text: "今日の話",
        card: null,
        attachments: [],
        files: [],
        timestamp: today,
      },
    ],
  });
  const separators = html.match(/class="stella-day"/g) ?? [];
  assertEquals(separators.length, 2, "one separator per day");
  assertStringIncludes(html, "昨日");
  assertStringIncludes(html, "今日");
});

Deno.test("StellaTranscript: the agent's time starts at its words' edge", () => {
  // The agent's message box is as wide as its content, so a right-aligned
  // time moved with every message's length. The `start` modifier pins it to
  // the left edge, where the words begin; the user's own time stays at the
  // right, under their capsule.
  const html = render({
    entries: [
      {
        role: "user",
        text: "短い",
        card: null,
        attachments: [],
        files: [],
        timestamp: 1,
      },
      {
        role: "assistant",
        text: "長い返事。".repeat(40),
        card: null,
        attachments: [],
        files: [],
        timestamp: 2,
      },
    ],
  });
  assertStringIncludes(html, 'class="msg-meta start"');
  assertStringIncludes(html, 'class="msg-meta"');
});

Deno.test("StellaTranscript: a prompt's pictures are drawn in the bubble", () => {
  const html = render({
    entries: [
      {
        role: "user",
        text: "",
        card: null,
        attachments: [],
        files: [{
          name: "image-1.png",
          path: "/home/agent/agents/a1/uploads/1-ab/01-image-1.png",
          size: 5,
          ref: "uploads/1-ab/01-image-1.png",
          image: true,
        }],
        timestamp: 1,
      },
    ],
  });
  // An image-only prompt would otherwise render as an empty capsule, and the
  // picture is read back from the machine rather than carried in the entry.
  assertStringIncludes(html, "msg-images");
  assertStringIncludes(html, "/upload?ref=uploads%2F1-ab%2F01-image-1.png");
});

Deno.test("StellaTranscript: a conversation with nothing said yet says so", () => {
  // A fresh agent's pane used to be blank, which reads as a view that failed
  // to load rather than as "nothing has been said yet".
  const html = render({});
  assertStringIncludes(html, "まだメッセージがありません");
  assertStringIncludes(html, 'role="status"');
  // A run in progress has the typing dots to say it is alive; the empty line
  // would contradict them.
  const running = render({ running: true });
  assertEquals(running.includes("まだメッセージがありません"), false);
});
