import { createTranslator } from "@lumisca/core/shared";
import { assert, assertEquals } from "@std/assert";
import {
  buildAgentEndNotification,
  buildEnvNotification,
  buildHandoverNotification,
  buildQuestionNotification,
  isNotifyEnabled,
  setNotifyEnabled,
  shouldNotifyFromState,
} from "./notify.ts";
import type { AskQuestion } from "./types.ts";

/** The notification builders take the translator explicitly (the callers
 * pass the store's, tests pin one), so every wording is asserted in both
 * languages instead of whichever one the runtime happens to default to. */
const ja = createTranslator("ja");
const en = createTranslator("en");

function question(overrides: Partial<AskQuestion> = {}): AskQuestion {
  return {
    id: "q1",
    question: "どれにしますか?",
    options: [{ label: "A" }, { label: "B" }],
    ...overrides,
  };
}

Deno.test("buildAgentEndNotification mentions the session", () => {
  const { title, body } = buildAgentEndNotification("My session", ja);
  assertEquals(title, "Lumisca");
  assert(body.includes("My session"), `body carries the name: ${body}`);
  assert(body.startsWith("「My session」"), `body frames the name: ${body}`);
});

Deno.test("buildAgentEndNotification follows the language", () => {
  const jaBody = buildAgentEndNotification("My session", ja).body;
  const enBody = buildAgentEndNotification("My session", en).body;
  assertEquals(jaBody, "「My session」の処理が完了しました");
  assertEquals(enBody, '"My session" has finished');
});

Deno.test("buildAgentEndNotification truncates long names", () => {
  const { body } = buildAgentEndNotification("あ".repeat(100), ja);
  // The name is capped at 60 characters, so the body is the wording plus
  // at most that many characters.
  const wording = ja("notify.agentFinished", { name: "" });
  assertEquals(Array.from(body).length <= 60 + wording.length, true);
  assert(!body.includes("あ".repeat(61)), "name is cut at 60 chars");
});

Deno.test("buildAgentEndNotification carries the start of the reply", () => {
  // "Finished" alone does not say whether opening the app is worth it — the
  // reason a routine's result needs a body (#41).
  const { body } = buildAgentEndNotification(
    "Morning check",
    ja,
    "## デプロイは緑\n\n問題はありません",
  );
  // The heading's mark is not part of what the run said: a toast has no
  // renderer, so a mark left in the text is punctuation the reader has to
  // read past.
  assertEquals(
    body,
    "「Morning check」の処理が完了しました\nデプロイは緑 問題はありません",
  );
  // A silent run has nothing to add, so the body is what it always was.
  assertEquals(
    buildAgentEndNotification("Morning check", ja, "  ").body,
    "「Morning check」の処理が完了しました",
  );
  // A whole document is cut to one toast's worth.
  const long = buildAgentEndNotification("S", ja, "あ".repeat(500)).body;
  assert(long.endsWith("あ"));
  assertEquals(Array.from(long.split("\n")[1] ?? "").length, 120);
});

Deno.test("buildQuestionNotification prefers the header", () => {
  const { body } = buildQuestionNotification(
    "S",
    [question({ header: "確認", question: "本文" })],
    ja,
  );
  assert(body.includes("質問"), `body says question: ${body}`);
  assert(body.includes("確認"), `body carries the header: ${body}`);
  assert(!body.includes("本文"), `body omits the long form: ${body}`);

  const english = buildQuestionNotification(
    "S",
    [question({ header: "Confirm", question: "Body" })],
    en,
  ).body;
  assert(
    english.startsWith('"S" has a question: Confirm'),
    `english wording: ${english}`,
  );
});

Deno.test("buildQuestionNotification falls back to the question text", () => {
  const { body } = buildQuestionNotification(
    "S",
    [question({ header: undefined })],
    ja,
  );
  assert(body.includes("どれにしますか?"), `body carries the text: ${body}`);
});

Deno.test("buildQuestionNotification handles no questions", () => {
  const { body } = buildQuestionNotification("S", [], ja);
  assert(body.includes("質問"), `body still asks for input: ${body}`);
  // Without a gist no separator is left behind.
  assertEquals(body.endsWith("あります"), true);
});

Deno.test("buildHandoverNotification names the session and the reason", () => {
  const { title, body } = buildHandoverNotification(
    "Aide",
    "The login form needs a password only you know",
    ja,
  );
  assertEquals(title, "Lumisca");
  assert(body.includes("「Aide」"), body);
  assert(body.includes("画面の操作を待っています"), body);
  assert(body.includes("password only you know"), body);
});

Deno.test("buildEnvNotification says which variable and which conversation", () => {
  const { title, body } = buildEnvNotification("Aide", "OPENAI_API_KEY", ja);
  assertEquals(title, "Lumisca");
  assert(body.includes("「Aide」"), body);
  assert(body.includes("OPENAI_API_KEY"), body);
  assert(body.includes("入力を待っています"), body);
  // The words of the dialog, not its layout: a toast has one line for it.
  assertEquals(
    buildEnvNotification("Aide", "GITHUB_TOKEN", en).body,
    '"Aide" is waiting for a value of GITHUB_TOKEN',
  );
});

Deno.test("buildHandoverNotification follows the language", () => {
  assertEquals(
    buildHandoverNotification("Aide", "a password", en).body,
    '"Aide" is waiting for you at the screen: a password',
  );
  assertEquals(
    buildHandoverNotification("Aide", "パスワード", ja).body,
    "「Aide」が画面の操作を待っています：パスワード",
  );
});

Deno.test("buildHandoverNotification folds whitespace and caps the reason", () => {
  // The reason is a sentence the model wrote for a banner, not a paragraph
  // a toast can hold.
  const { body } = buildHandoverNotification("Aide", "  needs\n\na  ", ja);
  assert(body.endsWith("：needs a"), body);
  const long = buildHandoverNotification("Aide", "あ".repeat(300), ja).body;
  assert(!long.includes("あ".repeat(121)), "reason is cut at 120 chars");
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
