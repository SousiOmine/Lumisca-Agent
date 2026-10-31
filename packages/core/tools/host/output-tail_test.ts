import { assertEquals } from "@std/assert";
import { OutputTail } from "./output-tail.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

Deno.test("output tail: a stream that fits is kept whole", () => {
  const tail = new OutputTail(64);
  tail.push(encode("hello "));
  tail.push(encode("world"));
  assertEquals(tail.truncated, false);
  assertEquals(tail.finish(), "hello world");
});

Deno.test("output tail: a longer stream keeps its tail and reports the cut", () => {
  const tail = new OutputTail(8);
  tail.push(encode("0123456789"));
  assertEquals(tail.truncated, true);
  assertEquals(tail.finish(), "23456789");
});

Deno.test("output tail: one chunk larger than the budget keeps its tail", () => {
  const tail = new OutputTail(5);
  tail.push(encode("abcdefghij"));
  assertEquals(tail.truncated, true);
  assertEquals(tail.finish(), "fghij");
});

Deno.test("output tail: a cut never leaves half a character", () => {
  // 15 bytes of three-byte characters; a 4-byte budget lands inside one of
  // them, and the half character must not come back as a replacement glyph.
  const tail = new OutputTail(4);
  tail.push(encode("あいうえお"));
  const text = tail.finish();
  assertEquals(text.includes("\uFFFD"), false, `broken glyph in ${text}`);
  assertEquals(text, "お");
});

Deno.test("output tail: a character split across chunks is decoded whole", () => {
  const encoded = encode("あ");
  const tail = new OutputTail(16);
  for (const byte of encoded) tail.push(new Uint8Array([byte]));
  assertEquals(tail.finish(), "あ");
});

Deno.test("output tail: the retained text never grows past the budget", () => {
  // 4 MB pushed through a 1 KB budget: what comes back is bounded by the
  // budget, and it is the END of the stream that survived.
  const limit = 1024;
  const tail = new OutputTail(limit);
  const chunk = encode("x".repeat(64 * 1024));
  for (let i = 0; i < 64; i++) tail.push(chunk);
  tail.push(encode("END-OF-STREAM"));
  const text = tail.finish();
  assertEquals(tail.truncated, true);
  assertEquals(text.length <= limit, true, `retained ${text.length} chars`);
  assertEquals(text.endsWith("END-OF-STREAM"), true);
});
