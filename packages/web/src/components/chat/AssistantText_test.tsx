import { test } from "bun:test";
import { fauxAssistantMessage } from "@lumisca/core";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { AssistantText } from "./AssistantText.tsx";

function render(text: string): string {
  initLocale("ja");
  return renderToString(
    createElement(AssistantText, {
      message: fauxAssistantMessage(text, { timestamp: 1 }),
      visualBase: "/visual/",
      onCardSend: () => {},
    }),
  );
}

/** A card as the agent writes it into its reply (shared/ui-markup). */
const CARD =
  '```card\n<Card title="確認">\n<Text>進めますか</Text>\n</Card>\n```';

test("AssistantText: the answer keeps a copy control", () => {
  // Drawn without a hover (see chat.css, .msg-action-btn.rest). A reader who
  // wants the command or the path back should not have to find a button that
  // is only painted once the pointer is already on it.
  const html = render("`bun run check` を通しました。");
  assertStringIncludes(html, 'class="msg-meta start"');
  assertStringIncludes(html, 'class="msg-action-btn rest"');
  assertStringIncludes(html, 'aria-label="コピー"');
});

test("AssistantText: a reply that is only a card has nothing to copy", () => {
  // A card's markup is how the conversation is written, not something the
  // agent said, so there is no prose to take away (see segmentsText).
  const html = render(CARD);
  assertStringIncludes(html, "ui-card");
  assertEquals(html.includes("msg-action-btn"), false);
});
