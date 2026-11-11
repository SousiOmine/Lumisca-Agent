import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "../ai/faux.ts";
import type { AgentMessage } from "../ai/types.ts";
import { TextCards, translateRunEvent } from "./run-events.ts";

/**
 * Reading the card being written into a reply's text.
 *
 * A stella conversation never receives the reply's text (it arrives whole),
 * so this is where the card is taken out of it, fragment by fragment, to be
 * drawn while the model writes it. What a client gets is appended, so each
 * piece must be only what became readable since the last one.
 */
Deno.test("TextCards: a card is read as its fence arrives", () => {
  const cards = new TextCards();
  const pieces: string[] = [];
  const push = (delta: string) => {
    const piece = cards.push(delta);
    if (piece !== null) pieces.push(piece.delta);
  };

  // Prose before the fence: nothing to draw.
  push("確認します。\n\n");
  assertEquals(pieces, []);

  // The fence opens; the card is drawn from its first character.
  push("```ca");
  assertEquals(pieces, []);
  push('rd\n<Card title="確認">');
  assertEquals(pieces, ['<Card title="確認">']);

  push("\n<Text>進めますか。</Text>");
  assertEquals(
    pieces.join(""),
    '<Card title="確認">\n<Text>進めますか。</Text>',
  );

  // The closing fence ends the card; the prose after it is not a card. What
  // the client already has is enough to draw: the partial parse stops at the
  // last block that closed, and the finished message replaces the live card
  // with the whole markup.
  push("\n</Card>\n```\n\n進めますか。");
  assertEquals(
    pieces.join(""),
    '<Card title="確認">\n<Text>進めますか。</Text>',
  );
});

Deno.test("TextCards: a second card starts over", () => {
  const cards = new TextCards();
  const first = cards.push("```card\n<Card><Text>a</Text></Card>");
  assertEquals(first?.delta, "<Card><Text>a</Text></Card>");
  const closed = cards.push("\n```\n");
  assertEquals(closed, null);

  const second = cards.push("```card\n<Card><Text>b");
  // A new id, so a client replaces what it drew instead of appending.
  assertEquals(second?.id === first?.id, false);
  assertEquals(second?.delta, "<Card><Text>b");
});

Deno.test("TextCards: a message's buffer does not leak into the next", () => {
  const cards = new TextCards();
  cards.push("```card\n<Card><Text>a");
  assertEquals(cards.end(), true);
  // The finished message carries the whole card; the next one starts empty.
  assertEquals(cards.push("plain prose"), null);
  assertEquals(cards.push("\n```card\n<Card/>"), {
    id: "text-2",
    delta: "<Card/>",
  });
});

Deno.test("TextCards: a message that drew nothing says so", () => {
  const cards = new TextCards();
  cards.push("ただの文です。");
  assertEquals(cards.end(), false);
});

Deno.test("translateRunEvent: a card in the text reaches a stella client", () => {
  // The conversation's clients never see the text, so the card is cut out of
  // it on the way out — with the text delta that carried it.
  const cards = new TextCards();
  const update = translateRunEvent(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "```card\n<Card><Text>a",
      },
    },
    "s1",
    cards,
  );
  assertEquals(
    update.events.map((event) => event.type),
    ["message_delta", "card_delta"],
  );
  assertEquals(update.events[1], {
    type: "card_delta",
    sessionId: "s1",
    toolCallId: "text-1",
    delta: "<Card><Text>a",
  });

  // The message ended drawing a card: if it turns out to be narration, the
  // client is told to drop it (the entry, when there is one, replaces it).
  const end = translateRunEvent(
    {
      type: "message_end",
      message: fauxAssistantMessage("```card\n<Card><Text>a") as AgentMessage,
    },
    "s1",
    cards,
  );
  assertEquals(
    end.events.map((event) => event.type),
    ["message_end", "card_end"],
  );
});

Deno.test("translateRunEvent: code mode's client cuts the card from the text", () => {
  // Nothing is extracted here: the client receives `message_delta` itself.
  const update = translateRunEvent(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "```card\n<Card><Text>a",
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
