import { assertEquals } from "@std/assert";
import { formatBytes } from "./format-bytes.ts";

Deno.test("formatBytes keeps small files in bytes and larger ones short", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(1023), "1023 B");
  assertEquals(formatBytes(1024), "1.0 KB");
  assertEquals(formatBytes(3913), "3.8 KB");
  assertEquals(formatBytes(38326), "37 KB");
  assertEquals(formatBytes(1024 * 1024), "1.0 MB");
  assertEquals(formatBytes(38 * 1024 * 1024), "38 MB");
});
