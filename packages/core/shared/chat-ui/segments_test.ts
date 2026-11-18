import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { segmentsText, splitChatText } from "./segments.ts";

test("chat-ui: a ui fence is lifted out of the prose", () => {
  assertEquals(
    splitChatText('前です。\n\n```ui\n{"version":1}\n```\n\n後です。'),
    [
      { type: "text", text: "前です。" },
      { type: "app", json: '{"version":1}' },
      { type: "text", text: "後です。" },
    ],
  );
});

test("chat-ui: text without a ui fence is one prose segment", () => {
  assertEquals(splitChatText("  ただの文です。\n\n続き。  "), [
    { type: "text", text: "ただの文です。\n\n続き。" },
  ]);
  assertEquals(splitChatText(""), []);
  assertEquals(splitChatText("   \n\n "), []);
});

test("chat-ui: a message may be cards alone, and several", () => {
  assertEquals(splitChatText('```ui\n{"a":1}\n```\n\n```ui\n{"b":2}\n```'), [
    { type: "app", json: '{"a":1}' },
    { type: "app", json: '{"b":2}' },
  ]);
});

test("chat-ui: an unclosed ui fence is a partial card", () => {
  assertEquals(splitChatText('```ui\n{"a":'), [{ type: "app", json: '{"a":' }]);
});

test("chat-ui: other fences stay prose, delimiters included", () => {
  assertEquals(
    splitChatText('```js\nconst a = 1;\n```\n\n```ui\n{"a":1}\n```'),
    [
      { type: "text", text: "```js\nconst a = 1;\n```" },
      { type: "app", json: '{"a":1}' },
    ],
  );
});

test("chat-ui: a tilde fence is a ui fence too", () => {
  assertEquals(splitChatText('~~~ui\n{"a":1}\n~~~'), [
    { type: "app", json: '{"a":1}' },
  ]);
});

test("chat-ui: a nested-looking fence inside another fence is prose", () => {
  assertEquals(splitChatText('```xml\n```ui\n{"a":1}\n```\n```'), [
    {
      type: "text",
      text: '```xml\n```ui\n{"a":1}\n```\n```',
    },
  ]);
});

test("chat-ui: only the exact info string names a card", () => {
  assertEquals(splitChatText('```json\n{"a":1}\n```'), [
    { type: "text", text: '```json\n{"a":1}\n```' },
  ]);
  assertEquals(splitChatText('```ui extra\n{"a":1}\n```'), [
    { type: "text", text: '```ui extra\n{"a":1}\n```' },
  ]);
});

test("chat-ui: segmentsText keeps only the prose", () => {
  assertEquals(
    segmentsText([
      { type: "text", text: "a" },
      { type: "app", json: '{"a":1}' },
      { type: "text", text: "b" },
    ]),
    "a\n\nb",
  );
  assertEquals(segmentsText([{ type: "app", json: '{"a":1}' }]), "");
});
