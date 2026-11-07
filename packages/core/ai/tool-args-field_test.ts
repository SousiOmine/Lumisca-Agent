import { assertEquals } from "@std/assert";
import { readJsonStringField, ToolArgsField } from "./tool-args-field.ts";

/**
 * Reading one string field out of a tool call's arguments while the model
 * writes them.
 *
 * The fragments arrive at arbitrary boundaries — inside an escape, inside a
 * key — so every case here is "what does the reader say at this cut".
 */

function feed(fragments: readonly string[], field = "card"): string {
  const reader = new ToolArgsField(field);
  let out = "";
  for (const fragment of fragments) out += reader.push(fragment) ?? "";
  return out;
}

Deno.test("ToolArgsField: one fragment with the whole call", () => {
  assertEquals(
    feed(['{"text":"hi","card":"<Card><Text>a</Text></Card>"}']),
    "<Card><Text>a</Text></Card>",
  );
});

Deno.test("ToolArgsField: the deltas grow by what arrived, not the total", () => {
  assertEquals(
    feed([
      '{"text":"done",',
      '"card":"<Card>',
      "",
      "<Text>ok",
      '</Text></Card>"}',
    ]),
    "<Card><Text>ok</Text></Card>",
  );
});

Deno.test("ToolArgsField: quotes inside the markup arrive escaped", () => {
  // The model writes card markup inside a JSON string, so every attribute
  // quote is escaped. What the screen draws must be the markup, not the JSON.
  assertEquals(
    feed([
      '{"card":"<Card title=\\"確認\\"><Metric label=\\"負荷\\" value=\\"81\\" /></Card>"}',
    ]),
    '<Card title="確認"><Metric label="負荷" value="81" /></Card>',
  );
});

Deno.test("ToolArgsField: an escape cut in half waits for its rest", () => {
  const reader = new ToolArgsField("card");
  assertEquals(reader.push('{"card":"a\\'), "a");
  assertEquals(reader.push('nb"}'), "\nb");
});

Deno.test("ToolArgsField: a \\u escape cut in half waits for its rest", () => {
  const reader = new ToolArgsField("card");
  assertEquals(reader.push('{"card":"a\\u30'), "a");
  assertEquals(reader.push('42"}'), "あ");
});

Deno.test("ToolArgsField: a card named inside the reply's own words is not this card", () => {
  // The text argument is written first and may mention the key; only the
  // object's own key is the card.
  assertEquals(
    readJsonStringField(
      '{"text":"send a \\"card\\": here","card":"<Card/>"}',
      "card",
    ),
    "<Card/>",
  );
});

Deno.test("ToolArgsField: a nested key of the same name is ignored", () => {
  assertEquals(
    readJsonStringField('{"meta":{"card":"nope"},"card":"yes"}', "card"),
    "yes",
  );
  assertEquals(readJsonStringField('{"meta":{"card":"nope"}}', "card"), null);
});

Deno.test("ToolArgsField: nothing is read before the key arrives", () => {
  const reader = new ToolArgsField("card");
  assertEquals(reader.push('{"text":"hello"'), null);
  assertEquals(reader.push(","), null);
  assertEquals(reader.push('"card":'), null);
  assertEquals(reader.push('"<Card'), "<Card");
});

Deno.test("ToolArgsField: a value that is not a string is not read", () => {
  assertEquals(readJsonStringField('{"card":null}', "card"), null);
  assertEquals(readJsonStringField('{"card":123}', "card"), null);
});
