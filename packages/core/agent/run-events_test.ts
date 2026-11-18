import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "../ai/faux.ts";
import type { AgentMessage } from "../ai/message.ts";

import { TextUi, translateRunEvent } from "./run-events.ts";

/**
 * Reading the app card being written into a reply's text.
 *
 * A stella conversation never receives the reply's text (it arrives whole),
 * so this is where the card is taken out of it, fragment by fragment, to be
 * drawn while the model writes it. What a client gets is appended, so each
 * piece must be only what became readable since the last one.
 */
test("TextUi: a card is read as its fence arrives", () => {
  const cards = new TextUi();
  const pieces: string[] = [];
  const push = (delta: string) => {
    const piece = cards.push(delta);
    if (piece !== null) pieces.push(piece.delta);
  };

  // Prose before the fence: nothing to draw.
  push("確認します。\n\n");
  assertEquals(pieces, []);

  // The info string can arrive in two deltas.
  push("```u");
  assertEquals(pieces, []);
  push('i\n{"version":1');
  assertEquals(pieces, ['{"version":1']);

  push(',"state":{}}');
  assertEquals(pieces.join(""), '{"version":1,"state":{}}');

  // The closing fence ends the card; the prose after it is not a card. The
  // finished message replaces the live card with the whole spec.
  push("\n```\n\n進めますか。");
  assertEquals(pieces.join(""), '{"version":1,"state":{}}');
});

test("TextUi: a second card starts over", () => {
  const cards = new TextUi();
  const first = cards.push('```ui\n{"a":1}');
  assertEquals(first?.delta, '{"a":1}');
  const closed = cards.push("\n```\n");
  assertEquals(closed, null);

  const second = cards.push('```ui\n{"b":2');
  // A new id, so a client replaces what it drew instead of appending.
  assertEquals(second?.id === first?.id, false);
  assertEquals(second?.delta, '{"b":2');
});

test("TextUi: a message's buffer does not leak into the next", () => {
  const cards = new TextUi();
  cards.push('```ui\n{"a":1');
  assertEquals(cards.end(), true);
  // The finished message carries the whole card; the next one starts empty.
  assertEquals(cards.push("plain prose"), null);
  assertEquals(cards.push('\n```ui\n{"b":2}'), {
    id: "text-2",
    delta: '{"b":2}',
  });
});

test("TextUi: a message that drew nothing says so", () => {
  const cards = new TextUi();
  cards.push("ただの文です。");
  assertEquals(cards.end(), false);
});

test("translateRunEvent: a card in the text reaches a stella client", () => {
  // The conversation's clients never see the text, so the card is cut out of
  // it on the way out — with the text delta that carried it.
  const cards = new TextUi();
  const update = translateRunEvent(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: '```ui\n{"version":1',
      },
    },
    "s1",
    cards,
  );
  assertEquals(
    update.events.map((event) => event.type),
    ["message_delta", "ui_delta"],
  );
  assertEquals(update.events[1], {
    type: "ui_delta",
    sessionId: "s1",
    toolCallId: "text-1",
    delta: '{"version":1',
  });

  // The message ended drawing a card: if it turns out to be narration, the
  // client is told to drop it (the entry, when there is one, replaces it).
  const end = translateRunEvent(
    {
      type: "message_end",
      message: fauxAssistantMessage('```ui\n{"version":1') as AgentMessage,
    },
    "s1",
    cards,
  );
  assertEquals(
    end.events.map((event) => event.type),
    ["message_end", "ui_end"],
  );
});

test("translateRunEvent: code mode's client cuts the card from the text", () => {
  // Nothing is extracted here: the client receives `message_delta` itself.
  const update = translateRunEvent(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: '```ui\n{"version":1',
      },
    },
    "s1",
    undefined,
  );
  assertEquals(
    update.events.map((event) => event.type),
    ["message_delta"],
  );
});
