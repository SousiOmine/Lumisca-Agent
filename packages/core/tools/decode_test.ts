import { assertEquals } from "@std/assert";
import { decodeOutput, detectOemLabel } from "./decode.ts";

// "日本語" in Shift_JIS (CP932).
const SHIFT_JIS_JP = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
// "日本語" in UTF-8.
const UTF8_JP = new TextEncoder().encode("日本語");

/** `decodeOutput` exists for one thing: a child process on Japanese Windows
 * writes its output in the OEM code page, not UTF-8, and the agent must not
 * read mojibake. The decision it makes is a two-step one — try UTF-8, fall
 * back to the label — so both steps and the fallback's failure mode are
 * checked together. */

Deno.test("decodeOutput prefers UTF-8 and falls back to the OEM label", () => {
  // Valid UTF-8 wins, whether or not a label was offered: a UTF-8 console on
  // an OEM-labeled system still emits UTF-8.
  assertEquals(decodeOutput(UTF8_JP, null), "日本語");
  assertEquals(decodeOutput(UTF8_JP, "shift_jis"), "日本語");
  // Non-UTF-8 bytes go through the label (a real `chcp 932` console).
  assertEquals(decodeOutput(SHIFT_JIS_JP, "shift_jis"), "日本語");
  // ASCII is the same in every code page.
  const ascii = new TextEncoder().encode("exit code: 1");
  assertEquals(decodeOutput(ascii, null), "exit code: 1");
  assertEquals(decodeOutput(ascii, "shift_jis"), "exit code: 1");
});

Deno.test("decodeOutput leaves bytes nothing can decode to the UTF-8 decoder", () => {
  // Neither valid UTF-8 nor decodable by the label: the replacement
  // character is visible, which is better than dropping the byte or
  // throwing inside a tool result.
  const text = decodeOutput(new Uint8Array([0x80]), null);
  assertEquals(text.includes("\uFFFD"), true);
});

Deno.test("detectOemLabel reports the label of this platform", async () => {
  // Windows asks the console; everywhere else there is no OEM code page to
  // detect. The second call is the cached one, which must agree — a cached
  // undefined turning into a different value would silently stop the
  // fallback above from ever running.
  const first = await detectOemLabel();
  if (Deno.build.os !== "windows") assertEquals(first, null);
  assertEquals(await detectOemLabel(), first);
});
