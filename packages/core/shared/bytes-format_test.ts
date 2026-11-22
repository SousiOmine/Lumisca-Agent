import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { formatBytes } from "./bytes-format.ts";

test("formatBytes keeps small files in bytes and larger ones short", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(1023), "1023 B");
  assertEquals(formatBytes(1024), "1 KB");
  assertEquals(formatBytes(1536), "1.5 KB");
  assertEquals(formatBytes(3913), "3.8 KB");
  assertEquals(formatBytes(38326), "37 KB");
  assertEquals(formatBytes(1024 * 1024), "1 MB");
  assertEquals(formatBytes(38 * 1024 * 1024), "38 MB");
});

test("formatBytes never steps past the unit a surface speaks", () => {
  assertEquals(formatBytes(200 * 1024, "KB"), "200 KB");
  assertEquals(formatBytes(200 * 1024, "MB"), "200 KB");
  assertEquals(formatBytes(5 * 1024 * 1024, "MB"), "5 MB");
});
