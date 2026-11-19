import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { formatAttachmentSize } from "./attachments.ts";

test("formatAttachmentSize: bytes stay bytes", () => {
  assertEquals(formatAttachmentSize(0), "0 B");
  assertEquals(formatAttachmentSize(1023), "1023 B");
});

test("formatAttachmentSize: a value between 10 KB and 1 MB keeps the KB unit", () => {
  // The old loop stepped up on `>= 10`, so 52 KB became 0 MB.
  assertEquals(formatAttachmentSize(52_000), "51 KB");
  assertEquals(formatAttachmentSize(10_240), "10 KB");
  assertEquals(formatAttachmentSize(999_000), "976 KB");
});

test("formatAttachmentSize: units change only when the value does not fit", () => {
  assertEquals(formatAttachmentSize(1024), "1 KB");
  assertEquals(formatAttachmentSize(1536), "1.5 KB");
  assertEquals(formatAttachmentSize(1_048_576), "1 MB");
  assertEquals(formatAttachmentSize(1_204_224), "1.1 MB");
  assertEquals(formatAttachmentSize(16_777_216), "16 MB");
});
