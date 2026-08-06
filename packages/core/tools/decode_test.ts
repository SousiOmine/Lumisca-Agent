import { assertEquals } from "jsr:@std/assert";
import { decodeOutput, detectOemLabel } from "./decode.ts";

// "日本語" in Shift_JIS (CP932).
const SHIFT_JIS_JP = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
// "日本語" in UTF-8.
const UTF8_JP = new TextEncoder().encode("日本語");

Deno.test("decodeOutput decodes valid UTF-8 as UTF-8", () => {
  const text = decodeOutput(UTF8_JP, null);
  assertEquals(text, "日本語");
});

Deno.test("decodeOutput decodes valid UTF-8 even when an OEM label is given", () => {
  const text = decodeOutput(UTF8_JP, "shift_jis");
  assertEquals(text, "日本語");
});

Deno.test("decodeOutput falls back to the OEM code page for non-UTF-8 bytes", () => {
  const text = decodeOutput(SHIFT_JIS_JP, "shift_jis");
  assertEquals(text, "日本語");
});

Deno.test("decodeOutput passes ASCII through unchanged", () => {
  const bytes = new TextEncoder().encode("exit code: 1");
  assertEquals(decodeOutput(bytes, null), "exit code: 1");
  assertEquals(decodeOutput(bytes, "shift_jis"), "exit code: 1");
});

Deno.test("decodeOutput leaves unresolvable bytes to the UTF-8 decoder", () => {
  // A byte that is neither valid UTF-8 nor decodable by the label.
  const text = decodeOutput(new Uint8Array([0x80]), null);
  assertEquals(text.includes("\uFFFD"), true);
});

Deno.test("detectOemLabel returns null on non-Windows", async () => {
  if (Deno.build.os === "windows") return;
  assertEquals(await detectOemLabel(), null);
});

Deno.test("detectOemLabel caches its result", async () => {
  const a = await detectOemLabel();
  const b = await detectOemLabel();
  assertEquals(a, b);
});
