import { assert, assertEquals } from "@std/assert";
import {
  buildAgentEndNotification,
  buildQuestionNotification,
  isNotifyEnabled,
  setNotifyEnabled,
  shouldNotifyFromState,
} from "./notify.ts";
import type { AskQuestion } from "./types.ts";

function question(overrides: Partial<AskQuestion> = {}): AskQuestion {
  return {
    id: "q1",
    question: "どれにしますか?",
    options: [{ label: "A" }, { label: "B" }],
    ...overrides,
  };
}

Deno.test("buildAgentEndNotification mentions the session", () => {
  const { title, body } = buildAgentEndNotification("My session");
  assertEquals(title, "Lumisca");
  assert(body.includes("My session"), `body carries the name: ${body}`);
  assert(body.includes("完了"), `body says completed: ${body}`);
});

Deno.test("buildAgentEndNotification truncates long names", () => {
  const { body } = buildAgentEndNotification("あ".repeat(100));
  assertEquals(
    Array.from(body).length <= 60 + "「」の処理が完了しました".length,
    true,
  );
  assert(!body.includes("あ".repeat(61)), "name is cut at 60 chars");
});

Deno.test("buildQuestionNotification prefers the header", () => {
  const { body } = buildQuestionNotification("S", [
    question({ header: "確認", question: "本文" }),
  ]);
  assert(body.includes("質問"), `body says question: ${body}`);
  assert(body.includes("確認"), `body carries the header: ${body}`);
  assert(!body.includes("本文"), `body omits the long form: ${body}`);
});

Deno.test("buildQuestionNotification falls back to the question text", () => {
  const { body } = buildQuestionNotification("S", [
    question({ header: undefined }),
  ]);
  assert(body.includes("どれにしますか?"), `body carries the text: ${body}`);
});

Deno.test("buildQuestionNotification handles no questions", () => {
  const { body } = buildQuestionNotification("S", []);
  assert(body.includes("質問"), `body still asks for input: ${body}`);
});

Deno.test("shouldNotifyFromState matrix", () => {
  const focused = {
    focused: true,
    minimized: false,
    visible: true,
    maximized: false,
  };
  // Visible and focused: the user is looking — no notification.
  assertEquals(shouldNotifyFromState(focused, false, true), false);
  // Unfocused window (another app in front): notify.
  assertEquals(
    shouldNotifyFromState({ ...focused, focused: false }, false, false),
    true,
  );
  // Minimized: notify even if the DOM still looks focused.
  assertEquals(
    shouldNotifyFromState({ ...focused, minimized: true }, false, true),
    true,
  );
  // Invisible window (another virtual desktop): notify.
  assertEquals(
    shouldNotifyFromState({ ...focused, visible: false }, false, true),
    true,
  );
  // Hidden document (minimized WebView / background tab): always notify,
  // even with a healthy-looking shell answer.
  assertEquals(shouldNotifyFromState(focused, true, false), true);
  // No shell (plain browser): fall back to DOM focus.
  assertEquals(shouldNotifyFromState(null, false, true), false);
  assertEquals(shouldNotifyFromState(null, false, false), true);
  assertEquals(shouldNotifyFromState(null, true, false), true);
});

Deno.test("notify enabled defaults to on and round-trips", () => {
  const prev = (() => {
    try {
      return localStorage.getItem("lumisca.notify.enabled");
    } catch {
      return null;
    }
  })();
  try {
    try {
      localStorage.removeItem("lumisca.notify.enabled");
    } catch {
      // Storage unavailable: only the default is observable.
    }
    assertEquals(isNotifyEnabled(), true);
    setNotifyEnabled(false);
    assertEquals(isNotifyEnabled(), false);
    setNotifyEnabled(true);
    assertEquals(isNotifyEnabled(), true);
  } finally {
    try {
      if (prev === null) localStorage.removeItem("lumisca.notify.enabled");
      else localStorage.setItem("lumisca.notify.enabled", prev);
    } catch {
      // Best-effort restore.
    }
  }
});
